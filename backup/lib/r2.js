const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } =
  require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");

const BUCKET = process.env.R2_BUCKET;

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".json": "application/json",
    ".wav": "audio/wav",
  }[ext] || "application/octet-stream";
}

async function uploadFile(localPath, r2Key) {
  const body = fs.createReadStream(localPath);
  const size = fs.statSync(localPath).size;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: r2Key,
    Body: body,
    ContentType: contentType(localPath),
    ContentLength: size,
  }));
  return size;
}

async function deleteObject(r2Key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: r2Key }));
}

async function exists(r2Key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: r2Key }));
    return true;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

module.exports = { uploadFile, deleteObject, exists, BUCKET };
