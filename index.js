import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import http from 'https';
import fetch from 'node-fetch';
import sharp from 'sharp';
import express from "express";
import cors from "cors";
const app = express();
const port = 3000;
app.use(cors())
let videoWidth;
let videoHeight;

const getVideoDimensions = (story) => {
  try {
    const path = `assets/${story.viewKey}/${story.title}.mp4`;
    return new Promise((resolve, reject) => {
      ffmpeg(path).ffprobe(0, (err, data) => {
        if (err) return reject(err);
        videoWidth = data.streams[0].width;
        videoHeight = data.streams[0].height;
        resolve();
      });
    });
  } catch (err) {
    console.log('Error getting video dimension: ', err);
  }
};

const getStickersPosAndTimes = async (story) => {
  let totalDuration = 0;
  let dumbStickersPosAndTimes = [];
  let textStickersPosAndTimes = [];
  const chapters = story.chapters;
  const resizedStickerFiles = fs
    .readdirSync(`assets/${story.viewKey}/resized`)
    .map((item) => `assets/${story.viewKey}/resized/${item}`);
  chapters.forEach((chapter, index) => {
    let stickers = chapter.stickers;
    stickers = stickers.filter(
      (sticker) => sticker.type === 'DUMB' || sticker.type === 'TEXT'
    );
    const hasStikers = stickers.length > 0;
    if (hasStikers) {
      stickers.forEach(async (sticker) => {
        let stickerStartTime;
        let stickerEndTime;
        if (index === 0) {
          stickerStartTime = 0;
          stickerEndTime = chapter.duration;
        } else if (index === chapters.length - 1) {
          stickerStartTime = totalDuration;
          stickerEndTime = totalDuration + chapter.duration;
        } else {
          stickerStartTime = totalDuration;
          stickerEndTime =
            totalDuration + chapters[index + 1].duration;
        }
        const stickerImageUrl = sticker.imageUrl;
        if (stickerImageUrl) {
          const stickerFileName = stickerImageUrl.slice(-6);
          const resizedSticker = resizedStickerFiles.find(
            (resizedStickerFile) =>
              resizedStickerFile.includes(stickerFileName)
          );
          dumbStickersPosAndTimes.push({
            resizedSticker,
            startTime: stickerStartTime,
            endTime: stickerEndTime,
            sticker,
          });
        } else {
          textStickersPosAndTimes.push({
            startTime: stickerStartTime,
            endTime: stickerEndTime,
            sticker,
          });
        }
      });
    }
    totalDuration += chapters[index].duration;
  });
  dumbStickersPosAndTimes = await Promise.all(
    dumbStickersPosAndTimes.map(async (item) => {
      const resizedStickerMetadata = await sharp(
        item.resizedSticker
      ).metadata();
      return {
        ...item,
        x: Math.floor(
          item.sticker.x * videoWidth -
            resizedStickerMetadata.width / 2
        ),
        y: Math.floor(
          item.sticker.y * videoHeight -
            resizedStickerMetadata.height / 2
        ),
      };
    })
  );
  return { dumbStickersPosAndTimes, textStickersPosAndTimes };
};

const buildStickerFilters = async (story) => {
  const dumbFilters = [];
  const textFilters = [];
  const { dumbStickersPosAndTimes, textStickersPosAndTimes } =
    await getStickersPosAndTimes(story);
  dumbStickersPosAndTimes.forEach((dumbStickersPosAndTime, index) => {
    const inputs =
      index === 0 ? `[0:v][1:v]` : `[tmp][${index + 1}:v]`;
    dumbFilters.push({
      filter: 'overlay',
      options: {
        enable: `between(t,${dumbStickersPosAndTime.startTime}, ${dumbStickersPosAndTime.endTime})`,
        x: dumbStickersPosAndTime.x,
        y: dumbStickersPosAndTime.y,
      },
      inputs,
      outputs: 'tmp',
    });
  });

  textStickersPosAndTimes.forEach((textStickersPosAndTime) => {
    textFilters.push({
      filter: 'drawtext',
      options: {
        text: textStickersPosAndTime.sticker.text,
        enable: `between(t,${textStickersPosAndTime.startTime},
          ${textStickersPosAndTime.endTime})`,
        fontsize: 40,
        fontcolor: 'white',
        boxcolor: 'black@0.5',
        box: 1,
        boxborderw: 10,
        x: '(w-text_w)/2',
        y: '(h-th-50)',
      },
    });
  });

  return { dumbFilters, textFilters };
};

const msToTime = (duration) => {
  var milliseconds = Math.floor((duration % 1000) / 100),
    seconds = Math.floor((duration / 1000) % 60),
    minutes = Math.floor((duration / (1000 * 60)) % 60),
    hours = Math.floor((duration / (1000 * 60 * 60)) % 24);

  hours = hours < 10 ? '0' + hours : hours;
  minutes = minutes < 10 ? '0' + minutes : minutes;
  seconds = seconds < 10 ? '0' + seconds : seconds;

  return hours + ':' + minutes + ':' + seconds + '.' + milliseconds;
};

const addSubtitles = (story) => {
  const video = ffmpeg(
    `assets/${story.viewKey}/storyWithStickers.mp4`
  );
  let subtitles = story.subtitles;
  const textToSrt = subtitles
    .map(
      (subtitle, index) =>
        `${index + 1}\n${msToTime(subtitle.startTime)} --> ${msToTime(
          subtitle.endTime
        )}\n${subtitle.text}`
    )
    .join('\n');
  const subtitlePart = `assets/${story.viewKey}/subtitle.srt`;
  fs.writeFileSync(subtitlePart, textToSrt, 'utf-8');
  video.complexFilter(
    `subtitles=${subtitlePart}:force_style='OutlineColour=&H40000000,BorderStyle=4,BackColour=&H40000000,Outline=0,Shadow=2,Fontname=Arial,Fontsize=10,Alignment=2,'`
  );
  video.output(`assets/${story.viewKey}/storyWithSubtitles.mp4`);
  video.on('end', async () => {
    console.log('Added subtitles');
    /* const { textFilters } = await buildStickerFilters(story);
    const hasTextFilters = textFilters.length > 0;
    hasTextFilters && addTexts(story, textFilters); */
  });
  video.run();
};

const addTexts = async (story, textFilters) => {
  /* const finalVideo = ffmpeg(
    `assets/${story.viewKey}/storyWithSubtitles.mp4`
  );
  finalVideo.videoFilters(textFilters);
  finalVideo.output(`assets/${story.viewKey}/final.mp4`);
  finalVideo.on('end', () => {
    console.log('Added texts');
  });
  finalVideo.run(); */
};

const addStickersAndSubtitlesToStory = async (story) => {
  const resizedFolderPath = `assets/${story.viewKey}/resized`;
  const resizedStickerFiles = fs
    .readdirSync(resizedFolderPath)
    .map((file) => `${resizedFolderPath}/${file}`);
  const storyFolderPath = `assets/${story.viewKey}`;
  try {
    const video = ffmpeg(`${storyFolderPath}/${story.title}.mp4`);
    video.addOptions([`-strict -${resizedStickerFiles.length}`]);
    story.chapters.forEach((chapter, i) => {
      chapter.stickers.forEach(async (sticker) => {
        if (sticker.imageUrl) {
          const stickerFilename = sticker.imageUrl.slice(-6);
          const stickerFiles = resizedStickerFiles.filter(
            (stickersFolderAndFilePath) =>
              stickersFolderAndFilePath.includes(stickerFilename)
          );
          const hasStickerFile = stickerFiles.length > 0;
          if (hasStickerFile) {
            const stickerFile = stickerFiles[0];
            video.input(stickerFile);
          }
        }
      });
    });
    const { dumbFilters } = await buildStickerFilters(story);
    video.complexFilter(dumbFilters, 'tmp');
    video.output(`${storyFolderPath}/storyWithStickers.mp4`);
    video.on('end', () => {
      console.log('Added stickers');
      const hasSubtitles = story.subtitles.length > 0;
      hasSubtitles && addSubtitles(story);
    });
    video.run();
  } catch (err) {
    console.log('Error adding stickers to story: ', err);
  }
};

const downloadAndSaveStory = async (story) => {
  try {
    const folderName = `assets/${story.viewKey}`;
    if (!fs.existsSync(folderName)) {
      fs.mkdirSync(folderName, { recursive: true }, (err) => {
        console.log('Error making story directory: ', err);
      });
      await download(story.videoUrl, `${folderName}/${story.title}`);
    }
  } catch (err) {
    console.log('Error downloading story: ', err);
  }
};

const download = (url, path) =>
  new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let fileType = response.headers['content-type']
        .split('/')[1]
        .split(';')[0];
      const statusCode = response.statusCode;
      if (statusCode !== 200) {
        return reject('Download error!');
      }
      const fullPath = path + '.' + fileType;
      const writeStream = fs.createWriteStream(fullPath);
      response.pipe(writeStream);

      writeStream.on('error', () => reject('Error writing to file!'));
      writeStream.on('finish', () =>
        writeStream.close(() => resolve({ fullPath, fileType }))
      );
    });
  }).catch((err) => console.error(err));

const downloadSaveResizeStickers = async (story) => {
  const stickersFolderPath = `assets/${story.viewKey}/stickers`;
  const resizedStickersFolderPath = `assets/${story.viewKey}/resized`;
  try {
    if (!fs.existsSync(stickersFolderPath)) {
      fs.mkdirSync(stickersFolderPath, { recursive: true }, (err) => {
        console.log('Error creating stickers directory');
      });
    }

    if (!fs.existsSync(resizedStickersFolderPath)) {
      fs.mkdirSync(
        resizedStickersFolderPath,
        { recursive: true },
        (err) => {
          console.log('Error creating resized stickers directory');
        }
      );
    }

    for (const chapter of story.chapters) {
      for (const sticker of chapter.stickers) {
        const validSticker =
          sticker.type !== 'LINK' && sticker.imageUrl;
        if (validSticker) {
          const stickerFileName = sticker.imageUrl.slice(-6);
          const stickerPathAndName = `${stickersFolderPath}/${stickerFileName}`;
          const { fileType } = await download(
            sticker.imageUrl,
            stickerPathAndName
          );
          const stickerPathNameWithFileExt = `${stickerPathAndName}.${fileType}`;
          const resizeStream = sharp(stickerPathNameWithFileExt);
          const stickerMetadata = await resizeStream.metadata();
          const resizedStickerPathNameAndExt = `${resizedStickersFolderPath}/${stickerFileName}.${fileType}`;
          await resizeStream
            .resize({
              width: Math.round(
                stickerMetadata.width * sticker.scale
              ),
            })
            .rotate(sticker.rotation, {
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .trim()
            .toFile(resizedStickerPathNameAndExt);
        }
      }
    }
  } catch (err) {
    console.log('Error downloading and saving story stickers: ', err);
  }
};

const getStory = async (viewKey) => {
  try {
    const url = `http://localhost:13050/api/v5/renders/${viewKey}`;
    return (await fetch(url)).json();
  } catch (err) {
    console.log('Error fetching story: ', err);
  }
};

// const init = async () => {
 
// };

// init();
app.get("/", (req, res) => {
  console.log('hello')
  res.json({name:"Hello World!"});
});
app.get("/video/:id", async (req, res) => {
    const story = await getStory(req.params.id);
    await downloadAndSaveStory(story);
    await getVideoDimensions(story);
    await downloadSaveResizeStickers(story);
    await addStickersAndSubtitlesToStory(story);
    res.sendFile(`assets/${req.params.id}/storyWithStickers.mp4`, { root: "." });
  });
  app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
  });