const express = require('express');
const speech = require('@google-cloud/speech');
const bodyparser = require('body-parser');
const Storage = require('@google-cloud/storage');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const s3fs = require('s3fs');
const ffmpeg = require('fluent-ffmpeg');
const s3fsImpl = new s3fs('hnginternship4', {
	accessKeyId: process.env.ACCESSKEYID,
	secretAccessKey: process.env.SECRET
});
const aws = require('aws-sdk');
const upload = multer({
	dest: 'uploads/'
});
const storage = new Storage({
	keyFilename: './keyfile.json'
});
const transcriber = new aws.TranscribeService({
	accessKeyId: process.env.ACCESSKEYID,
	secretAccessKey: process.env.SECRET,
	region: 'eu-west-1'
});
const client = new speech.SpeechClient({
	keyFilename: './keyfile.json'
});

var app = express();

// Needed for CORS
app.use(function(req, res, next) {
	res.header('Access-Control-Allow-Origin', '*');
	res.header('Access-Control-Allow-Credentials', true);
	res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
	res.header(
		'Access-Control-Allow-Headers',
		'Origin,X-Requested-With,Content-Type,Accept,content-type,application/json'
	);
	next();
});

app.use(bodyparser.json());

// Endpoint to transcribe mp3 via Cloud Speech To Text
app.post('/transcribe/google/:type', upload.single('audio'), function(
	req,
	res
) {
	const bucketName = 'hnginternship';

	// Converts the MP3 to a mono channel 44100 sampleRate FLAC file
	ffmpeg(`${req.file.path}`)
		.audioFrequency(44100)
		.audioChannels(1)
		.toFormat('flac')
		.on('end', () => {
			try {
				storage
					.bucket(bucketName)
					.upload(`${req.file.path}.flac`)
					.then(async () => {
						await storage
							.bucket(bucketName)
							.file(`${req.file.filename}.flac`)
							.makePublic();

						const gcsUri = `gs://${bucketName}/${req.file.filename + '.flac'}`;
						const audio = {
							uri: gcsUri
						};
						const config = {
							encoding: 'FLAC',
							sampleRateHertz: 44100,
							languageCode: 'en-US'
						};
						const request = {
							audio,
							config
						};

						// Start the transcription job on Cloud Speech To Text
						client
							.longRunningRecognize(request)
							.then(data => {
								const response = data[0];
								const operation = response;
								return operation.promise();
							})
							.then(data => {
								const response = data[0];
								const transcription = response.results
									.map(result => result.alternatives[0].transcript)
									.join('\n');
								res.send({
									transcription
								});

								fs.unlink('./' + req.file.path, () => {});
								fs.unlink(`./${req.file.path}.flac`, () => {});
							})
							.catch(err => {
								console.error('Google', err);
								res.status(500).send({
									error: err
								});
							});
					});
			} catch (error) {
				console.log(error);
				res.status(500).send({
					error: 'Something went wrong.'
				});
			}
		})
		.save(`${req.file.path}.flac`);
});

// Endpoint to transcribe mp3 via Amazon Transcribe
app.post('/transcribe/amazon/:type', upload.single('audio'), function(
	req,
	res
) {
	// Converts the MP3 to a mono channel 44100 sampleRate FLAC file
	ffmpeg(`${req.file.path}`)
		.audioFrequency(44100)
		.audioChannels(1)
		.toFormat('flac')
		.on('end', () => {
			var stream = fs.createReadStream(`${req.file.path}.flac`);
			let s3Path = `${req.file.path}.flac`;

			// Uploads the FLAC file to an Amazon S3 bucket
			s3fsImpl.writeFile(s3Path, stream).then(function() {
				fs.unlink('./' + req.file.path, () => {});
				fs.unlink(`./${req.file.path}.flac`, () => {});

				var params = {
					LanguageCode: 'en-US',
					Media: {
						MediaFileUri: `https://s3-eu-west-1.amazonaws.com/${s3fsImpl.getPath(
							s3Path
						)}`
					},
					MediaFormat: 'flac',
					TranscriptionJobName: req.file.filename,
					MediaSampleRateHertz: 44100
				};

				// Starts the Amazon transcription job for the FLAC file
				transcriber.startTranscriptionJob(params, (err, data) => {
					if (err) {
						console.log('Amazon', err);
						res.status(422).send({
							error: err.stack
						});
					} else {
						res.send({
							transcriptionJobName: req.file.filename
						});
					}
				});
			});
		})
		.save(`${req.file.path}.flac`);
});

// Endpoint used to check if an Amazon transcription job has been completed
app.get('/transcribe/amazon/status/:name', function(req, res) {
	let params = {
		TranscriptionJobName: req.params.name
	};

	transcriber.getTranscriptionJob(params, async (err, data) => {
		if (!err && data.TranscriptionJob.TranscriptionJobStatus === 'COMPLETED') {
			// Transcription has completed. We'll download the file containing the results, parse it and return it to the frontend
			let response = await axios.get(
				data.TranscriptionJob.Transcript.TranscriptFileUri
			);

			let transcript = response.data.results.transcripts.reduce(
				(prev, next) => `${prev} ${next}`
			);

			res.send({
				transcription: transcript.transcript,
				status: 'completed'
			});
		} else {
			res.send({
				status: 'in_progress'
			});
		}
	});
});

// listen for requests :)
var listener = app.listen(process.env.PORT, function() {
	console.log('Your app is listening on port ' + listener.address().port);
});
