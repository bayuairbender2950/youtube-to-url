const express = require("express");
const ffmpegPath = require("ffmpeg-static");
const cp = require("child_process");
const stream = require("stream");
const ytdl = require("@distube/ytdl-core");

const validQualities = [
  "144p",
  "240p",
  "360p",
  "480p",
  "720p",
  "1080p",
  "1440p",
  "2160p",
];

const getVideoFormat = (formats, quality) => {
  console.log(formats);

  if (["2160p"].includes(quality)) {
    const hdrFormat = formats.find(
      (format) =>
        format.qualityLabel === quality &&
        format.hasVideo &&
        (format.colorInfo?.primaries === "bt2020" ||
          format.colorInfo?.transferCharacteristics === "smpte2084")
    );
    if (hdrFormat) return hdrFormat;
  }

  let format = formats.find(
    (format) =>
      format.qualityLabel === quality && format.hasVideo && format.hasAudio
  );

  if (!format) {
    format = formats.find(
      (format) => format.qualityLabel === quality && format.hasVideo
    );
  }

  return format;
};

const ytmixer = (info, quality, options = {}) => {
  const result = new stream.PassThrough({
    highWaterMark: options.highWaterMark || 1024 * 512,
  });

  const videoFormat = getVideoFormat(info.formats, quality);

  if (!videoFormat) {
    result.emit(
      "error",
      new Error(`Requested quality ${quality} is not available for this video`)
    );
    return result;
  }

  if (videoFormat.hasAudio) {
    ytdl.downloadFromInfo(info, { format: videoFormat }).pipe(result);
  } else {
    let audioStream = ytdl.downloadFromInfo(info, {
      ...options,
      quality: "highestaudio",
    });
    let videoStream = ytdl.downloadFromInfo(info, { format: videoFormat });

    let ffmpegArgs = [
      "-loglevel",
      "error",
      "-hide_banner",
      "-i",
      "pipe:3",
      "-i",
      "pipe:4",
      "-map",
      "0:a",
      "-map",
      "1:v",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-f",
      "matroska",
      "pipe:5"
    ];

    let ffmpegProcess = cp.spawn(ffmpegPath, ffmpegArgs, {
      windowsHide: true,
      stdio: ["inherit", "inherit", "inherit", "pipe", "pipe", "pipe"],
    });
    audioStream.pipe(ffmpegProcess.stdio[3]);
    videoStream.pipe(ffmpegProcess.stdio[4]);
    ffmpegProcess.stdio[5].pipe(result);
  }

  return result;
};

const app = express();

app.get("/video/:videoId/:resolution-video.mp4", async (req, res) => {
  const videoId = req.params.videoId;
  const resolution = req.params.resolution;

  if (!validQualities.includes(resolution)) {
    return res.status(400).send(`Invalid quality. Valid options are: ${validQualities.join(", ")}`);
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const info = await ytdl.getInfo(videoUrl);
    const videoTitle = info.videoDetails.title.replace(/[^\w\s]/gi, "");
    const videoFormat = getVideoFormat(info.formats, resolution);

    if (!videoFormat) {
      return res.status(400).send(`Requested quality ${resolution} is not available for this video`);
    }

    const isHDR =
      videoFormat.colorInfo?.primaries === "bt2020" ||
      videoFormat.colorInfo?.transferCharacteristics === "smpte2084";
    const fileName = `${videoTitle}_${resolution}${isHDR ? "_HDR" : ""}.mp4`;

    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Content-Type", "video/mp4");

    const mixer = ytmixer(info, resolution);
    mixer.on("error", (err) => {
      console.error("Mixer error:", err);
      if (!res.headersSent) {
        res.status(400).send(err.message);
      }
    });

    // Handle HTTP range requests for seeking
    const range = req.headers.range;
    if (range) {
      const [start, end] = range.replace(/bytes=/, "").split("-").map(Number);
      const videoSize = videoFormat.contentLength;
      const chunkSize = (end ? end : videoSize - 1) - start + 1;
      const fileEnd = Math.min(start + chunkSize, videoSize - 1);

      res.setHeader("Content-Range", `bytes ${start}-${fileEnd}/${videoSize}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", chunkSize);
      res.status(206);

      mixer.pipe(res);
    } else {
      res.setHeader("Content-Length", videoFormat.contentLength);
      mixer.pipe(res);
    }

  } catch (error) {
    console.error("Error:", error);
    if (!res.headersSent) {
      res.status(500).send("An error occurred while processing the video");
    }
  }
});

app.listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
