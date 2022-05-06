"use strict";

import line from "@line/bot-sdk";
import express from "express";
import fs from "fs";
import path from "path";
import cp from "child_process";
import ngrok from "ngrok";

import dotenv from "dotenv";
dotenv.config();

import {
  writeUserData,
  getUserData,
  getUserCurrentGame,
  proceedNextStage,
  newGameData,
  removeUserData,
  endGame,
} from "./lib/firebase.js";

// create LINE SDK config from env variables
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// base URL for webhook server
let baseURL = process.env.BASE_URL;

// create LINE SDK client
const client = new line.Client(config);

// create Express app
// about Express itself: https://expressjs.com/
const app = express();

// questions related imports
const rawData = fs.readFileSync("./static/questions.json");
const { questions } = JSON.parse(rawData);

const { flex_messages } = JSON.parse(
  fs.readFileSync("./static/flex_messages.json")
);

// serve static and downloaded files
app.use("/static", express.static("static"));
app.use("/downloaded", express.static("downloaded"));

app.get("/callback", (req, res) => {
  const testDest = "Uc0031535d95ce837f61157a0f2cc3b89";

  const testMessage = {
    type: "text",
    text: "Push Message Test",
  };

  client
    .pushMessage(testDest, testMessage)
    .then((res) => {
      res.json({ message: testMessage });
    })
    .catch((err) => res.json(err));
});

// webhook callback
app.post("/callback", line.middleware(config), (req, res) => {
  if (req.body.destination) {
    console.log("Destination User ID: " + req.body.destination);
  }

  // req.body.events should be an array of events
  if (!Array.isArray(req.body.events)) {
    return res.status(500).end();
  }

  // handle events separately
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.end())
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// simple reply function
const replyText = (token, texts) => {
  texts = Array.isArray(texts) ? texts : [texts];
  return client.replyMessage(
    token,
    texts.map((text) => ({ type: "text", text }))
  );
};

const sendQuestion = (token, stage) => {
  const question = questions[stage];
  const texts = Array.isArray(question.question)
    ? question.question
    : [question.question];
  const message = texts.map((text) => ({ type: "text", text }));
  if (stage > 1) message.unshift({ type: "text", text: "Correct!" });
  if (question.picture) {
    const picUrl = `${baseURL}/static/question_img/${question.picture}`;
    const original = `${picUrl}.jpg`;
    const preview = `${picUrl}-preview.jpg`;
    message.push({
      type: "image",
      originalContentUrl: original,
      previewImageUrl: preview,
    });
  }

  return client.replyMessage(token, message);
};

// callback function to handle a single event
function handleEvent(event) {
  if (event.replyToken && event.replyToken.match(/^(.)\1*$/)) {
    return console.log("Test hook recieved: " + JSON.stringify(event.message));
  }

  switch (event.type) {
    case "message":
      const message = event.message;

      switch (message.type) {
        case "text":
          return handleText(message, event.replyToken, event.source);
        case "image":
          return handleImage(message, event.replyToken);
        case "video":
          return handleVideo(message, event.replyToken);
        case "audio":
          return handleAudio(message, event.replyToken);
        case "location":
          return handleLocation(message, event.replyToken);
        case "sticker":
          return handleSticker(message, event.replyToken);
        default:
          throw new Error(`Unknown message: ${JSON.stringify(message)}`);
      }

    case "follow":
      // Generate database
      getUserData(event.source.userId).catch((err) => {
        client.getProfile(event.source.userId).then((profile) => {
          writeUserData(event.source.userId, {
            name: profile.displayName,
          });
        });
      });

      return client.replyMessage(event.replyToken, {
        type: "template",
        altText: "Game start",
        template: {
          type: "confirm",
          text: "Start Game?",
          actions: [
            { label: "ゲーム開始", type: "message", text: "ゲーム開始" },
            {
              label: "詳しく教えてください",
              type: "message",
              text: "詳しく教えてください",
            },
          ],
        },
      });

    case "unfollow":
      removeUserData(event.source.userId);
      return console.log(`Unfollowed this bot: ${JSON.stringify(event)}`);

    case "join":
      return replyText(event.replyToken, `Joined ${event.source.type}`);

    case "leave":
      return console.log(`Left: ${JSON.stringify(event)}`);

    case "postback":
      let data = event.postback.data;
      if (data === "DATE" || data === "TIME" || data === "DATETIME") {
        data += `(${JSON.stringify(event.postback.params)})`;
      }
      return replyText(event.replyToken, `Got postback: ${data}`);

    case "beacon":
      return replyText(event.replyToken, `Got beacon: ${event.beacon.hwid}`);

    default:
      throw new Error(`Unknown event: ${JSON.stringify(event)}`);
  }
}

async function handleText(message, replyToken, source) {
  const buttonsImageURL = `${baseURL}/static/buttons/1040.jpg`;

  // userId が必要。常時は問題ないはず。
  if (!source.userId) return replyText(replyToken, "ユーザーIDが必要");

  // load the database
  const userData = await getUserData(source.userId);
  const { data } = userData;

  if (!data.current_game) {
    // データベースの存在を確認する

    // でなければ「ゲーム開始」だけ対応
    switch (message.text) {
      case "ゲーム開始":
        if (source.userId) {
          const profile = await client.getProfile(source.userId);

          // データベースが既にあるか
          await newGameData(source.userId);

          return client.replyMessage(replyToken, {
            type: "template",
            altText: "Game start confirmation",
            template: {
              type: "confirm",
              text: "Are you ready?",
              actions: [
                { label: "Yes", type: "message", text: "Yes!" },
                { label: "No", type: "message", text: "No!" },
              ],
            },
          });
        }
      case "詳しく教えてください。":
        return replyText(replyToken, [
          `(必要であれば、プレーヤーにゲームを説明してあげて)`,
        ]);

      default:
        return replyText(replyToken, [
          `(tell them to say whether "ゲーム開始" or if you're not sure about the game ask 詳しく教えてください。)`,
        ]);
    }
  }

  const { data: gameData } = await getUserCurrentGame(source.userId);
  const stage = gameData.stage;
  const questionData = questions[stage];

  switch (message.text) {
    case "ゲーム開始":
      return replyText(replyToken, [`bro you're in a game rn`]);

    case "詳しく教えてください。":
      return replyText(replyToken, [
        `(必要であれば、プレーヤーにゲームを説明してあげて)`,
      ]);

    case "profile":
      if (source.userId) {
        const profile = await client.getProfile(source.userId);
        return await replyText(replyToken, [
          `Display name: ${profile.displayName}`,
          `Status message: ${profile.statusMessage}`,
        ]);
      } else {
        return replyText(
          replyToken,
          "Bot can't use profile API without user ID"
        );
      }
    case "add to database":
      if (source.userId) {
        const profile = await client.getProfile(source.userId);
        writeUserData(source.userId, {
          name: profile.displayName,
          message: profile.statusMessage || "(No message)",
        });
      } else {
        return replyText(
          replyToken,
          "Bot can't use profile API without user ID"
        );
      }
    case "my database":
      if (source.userId) {
        try {
          const res = await getUserData(source.userId);
          const { name, message } = res.data;
          return await replyText(replyToken, [
            `Display name: ${name}`,
            `Status message: ${message}`,
          ]);
        } catch (e) {
          return await replyText(replyToken, [`${e}`]);
        }
      } else {
        return replyText(
          replyToken,
          "Bot can't use profile API without user ID"
        );
      }

    case "buttons":
      return client.replyMessage(replyToken, {
        type: "template",
        altText: "Buttons alt text",
        template: {
          type: "buttons",
          thumbnailImageUrl: buttonsImageURL,
          title: "My button sample",
          text: "Hello, my button",
          actions: [
            { label: "Go to line.me", type: "uri", uri: "https://line.me" },
            { label: "Say hello1", type: "postback", data: "hello こんにちは" },
            {
              label: "言 hello2",
              type: "postback",
              data: "hello こんにちは",
              text: "hello こんにちは",
            },
            { label: "Say message", type: "message", text: "Rice=米" },
          ],
        },
      });
    case "confirm":
      return client.replyMessage(replyToken, {
        type: "template",
        altText: "Confirm alt text",
        template: {
          type: "confirm",
          text: "Do it?",
          actions: [
            { label: "Yes", type: "message", text: "Yes!" },
            { label: "No", type: "message", text: "No!" },
          ],
        },
      });
    case "carousel":
      return client.replyMessage(replyToken, {
        type: "template",
        altText: "Carousel alt text",
        template: {
          type: "carousel",
          columns: [
            {
              thumbnailImageUrl: buttonsImageURL,
              title: "hoge",
              text: "fuga",
              actions: [
                { label: "Go to line.me", type: "uri", uri: "https://line.me" },
                {
                  label: "Say hello1",
                  type: "postback",
                  data: "hello こんにちは",
                },
              ],
            },
            {
              thumbnailImageUrl: buttonsImageURL,
              title: "hoge",
              text: "fuga",
              actions: [
                {
                  label: "言 hello2",
                  type: "postback",
                  data: "hello こんにちは",
                  text: "hello こんにちは",
                },
                { label: "Say message", type: "message", text: "Rice=米" },
              ],
            },
          ],
        },
      });
    case "image carousel":
      return client.replyMessage(replyToken, {
        type: "template",
        altText: "Image carousel alt text",
        template: {
          type: "image_carousel",
          columns: [
            {
              imageUrl: buttonsImageURL,
              action: {
                label: "Go to LINE",
                type: "uri",
                uri: "https://line.me",
              },
            },
            {
              imageUrl: buttonsImageURL,
              action: {
                label: "Say hello1",
                type: "postback",
                data: "hello こんにちは",
              },
            },
            {
              imageUrl: buttonsImageURL,
              action: {
                label: "Say message",
                type: "message",
                text: "Rice=米",
              },
            },
            {
              imageUrl: buttonsImageURL,
              action: {
                label: "datetime",
                type: "datetimepicker",
                data: "DATETIME",
                mode: "datetime",
              },
            },
          ],
        },
      });
    case "datetime":
      return client.replyMessage(replyToken, {
        type: "template",
        altText: "Datetime pickers alt text",
        template: {
          type: "buttons",
          text: "Select date / time !",
          actions: [
            {
              type: "datetimepicker",
              label: "date",
              data: "DATE",
              mode: "date",
            },
            {
              type: "datetimepicker",
              label: "time",
              data: "TIME",
              mode: "time",
            },
            {
              type: "datetimepicker",
              label: "datetime",
              data: "DATETIME",
              mode: "datetime",
            },
          ],
        },
      });
    case "imagemap":
      return client.replyMessage(replyToken, {
        type: "imagemap",
        baseUrl: `${baseURL}/static/rich`,
        altText: "Imagemap alt text",
        baseSize: { width: 1040, height: 1040 },
        actions: [
          {
            area: { x: 0, y: 0, width: 520, height: 520 },
            type: "uri",
            linkUri: "https://store.line.me/family/manga/en",
          },
          {
            area: { x: 520, y: 0, width: 520, height: 520 },
            type: "uri",
            linkUri: "https://store.line.me/family/music/en",
          },
          {
            area: { x: 0, y: 520, width: 520, height: 520 },
            type: "uri",
            linkUri: "https://store.line.me/family/play/en",
          },
          {
            area: { x: 520, y: 520, width: 520, height: 520 },
            type: "message",
            text: "URANAI!",
          },
        ],
        video: {
          originalContentUrl: `${baseURL}/static/imagemap/video.mp4`,
          previewImageUrl: `${baseURL}/static/imagemap/preview.jpg`,
          area: {
            x: 280,
            y: 385,
            width: 480,
            height: 270,
          },
          externalLink: {
            linkUri: "https://line.me",
            label: "LINE",
          },
        },
      });
    case "bye":
      switch (source.type) {
        case "user":
          return replyText(replyToken, "Bot can't leave from 1:1 chat");
        case "group":
          await replyText(replyToken, "Leaving group");
          return await client.leaveGroup(source.groupId);
        case "room":
          await replyText(replyToken, "Leaving room");
          return await client.leaveRoom(source.roomId);
      }
    case "再送":
      return await sendQuestion(replyToken, stage);
    default:
      if (message.text === questionData.answer) {
        //proceed to the next stage
        const res = await proceedNextStage(source.userId);

        if (res) {
          if (stage === questions.length - 1) {
            endGame(source.userId).then((time) => {
              client.getProfile(source.userId).then((profile) => {
                return replyText(
                  replyToken,
                  `Congratulations, ${profile.displayName}! You completed every stage in ${time}`
                );
              });
            });
          } else {
            return await sendQuestion(replyToken, stage + 1);
          }
        }
      } else {
        if (!stage) {
          return await replyText(replyToken, "Please just press Yes!");
        } else {
          return await replyText(replyToken, "Wrong answers");
        }
      }
  }
}

function handleImage(message, replyToken) {
  let getContent;
  if (message.contentProvider.type === "line") {
    const downloadPath = path.join(
      __dirname,
      "downloaded",
      `${message.id}.jpg`
    );
    const previewPath = path.join(
      __dirname,
      "downloaded",
      `${message.id}-preview.jpg`
    );

    getContent = downloadContent(message.id, downloadPath).then(
      (downloadPath) => {
        // ImageMagick is needed here to run 'convert'
        // Please consider about security and performance by yourself
        cp.execSync(
          `convert -resize 240x jpeg:${downloadPath} jpeg:${previewPath}`
        );

        return {
          originalContentUrl:
            baseURL + "/downloaded/" + path.basename(downloadPath),
          previewImageUrl:
            baseURL + "/downloaded/" + path.basename(previewPath),
        };
      }
    );
  } else if (message.contentProvider.type === "external") {
    getContent = Promise.resolve(message.contentProvider);
  }

  return getContent.then(({ originalContentUrl, previewImageUrl }) => {
    return client.replyMessage(replyToken, {
      type: "image",
      originalContentUrl,
      previewImageUrl,
    });
  });
}

function handleVideo(message, replyToken) {
  let getContent;
  if (message.contentProvider.type === "line") {
    const downloadPath = path.join(
      __dirname,
      "downloaded",
      `${message.id}.mp4`
    );
    const previewPath = path.join(
      __dirname,
      "downloaded",
      `${message.id}-preview.jpg`
    );

    getContent = downloadContent(message.id, downloadPath).then(
      (downloadPath) => {
        // FFmpeg and ImageMagick is needed here to run 'convert'
        // Please consider about security and performance by yourself
        cp.execSync(`convert mp4:${downloadPath}[0] jpeg:${previewPath}`);

        return {
          originalContentUrl:
            baseURL + "/downloaded/" + path.basename(downloadPath),
          previewImageUrl:
            baseURL + "/downloaded/" + path.basename(previewPath),
        };
      }
    );
  } else if (message.contentProvider.type === "external") {
    getContent = Promise.resolve(message.contentProvider);
  }

  return getContent.then(({ originalContentUrl, previewImageUrl }) => {
    return client.replyMessage(replyToken, {
      type: "video",
      originalContentUrl,
      previewImageUrl,
    });
  });
}

function handleAudio(message, replyToken) {
  let getContent;
  if (message.contentProvider.type === "line") {
    const downloadPath = path.join(
      __dirname,
      "downloaded",
      `${message.id}.m4a`
    );

    getContent = downloadContent(message.id, downloadPath).then(
      (downloadPath) => {
        return {
          originalContentUrl:
            baseURL + "/downloaded/" + path.basename(downloadPath),
        };
      }
    );
  } else {
    getContent = Promise.resolve(message.contentProvider);
  }

  return getContent.then(({ originalContentUrl }) => {
    return client.replyMessage(replyToken, {
      type: "audio",
      originalContentUrl,
      duration: message.duration,
    });
  });
}

function downloadContent(messageId, downloadPath) {
  return client.getMessageContent(messageId).then(
    (stream) =>
      new Promise((resolve, reject) => {
        const writable = fs.createWriteStream(downloadPath);
        stream.pipe(writable);
        stream.on("end", () => resolve(downloadPath));
        stream.on("error", reject);
      })
  );
}

function handleLocation(message, replyToken) {
  return client.replyMessage(replyToken, {
    type: "location",
    title: message.title,
    address: message.address,
    latitude: message.latitude,
    longitude: message.longitude,
  });
}

function handleSticker(message, replyToken) {
  return client.replyMessage(replyToken, {
    type: "sticker",
    packageId: message.packageId,
    stickerId: message.stickerId,
  });
}

// listen on port
const port = process.env.PORT || 3000;
app.listen(port, () => {
  if (baseURL) {
    console.log(`listening on ${baseURL}:${port}/callback`);
  } else {
    console.log("It seems that BASE_URL is not set. Connecting to ngrok...");
    ngrok
      .connect(port)
      .then((url) => {
        baseURL = url;
        console.log(`listening on ${baseURL}/callback`);
      })
      .catch(console.error);
  }
});
