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
  updateWrong,
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
import { questions, flex_messages } from "./lib/questions.js";

// serve static and downloaded files
app.use("/static", express.static("static"));
app.use("/downloaded", express.static("downloaded"));

function sendFlexMessage(
  replyToken = "",
  flex_message,
  altText = "A flex message"
) {
  const testMessage = {
    type: "flex",
    altText: altText,
    contents: flex_message,
  };

  if (replyToken.length > 0) {
    return client.replyMessage(replyToken, testMessage);
  }
}

app.get("/callback", (req, res) => {
  const testDest = "Uc0031535d95ce837f61157a0f2cc3b89";

  const testMessage = {
    type: "flex",
    altText: "test message",
    contents: flex_messages.sample,
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
    const originalPath = path.join(
      path.resolve(),
      "static/question_img",
      `${question.picture}.jpg`
    );
    const previewPath = path.join(
      path.resolve(),
      "static/question_img",
      `${question.picture}-preview.jpg`
    );

    if (!fs.existsSync(previewPath)) {
      const originalContentUrl =
        baseURL + "/static/question_img/" + path.basename(originalPath);
      const previewImageUrl =
        baseURL + "/static/question_img/" + path.basename(previewPath);

      cp.execSync(
        `convert -resize 240x jpeg:${originalPath} jpeg:${previewPath}`
      );
    }

    message.push({
      type: "image",
      originalContentUrl,
      previewImageUrl,
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

      return sendFlexMessage(
        event.replyToken,
        flex_messages.game_start,
        "Are you ready to start the game?"
      );

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
              text: "Please Pick difficulty",
              actions: [
                { label: "Easy", type: "message", text: "easy" },
                { label: "Hard", type: "message", text: "hard" },
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

  const { data: gameData, key } = await getUserCurrentGame(source.userId);
  const stage = gameData.progress.length - 1;

  const questionData = questions[stage];

  switch (message.text) {
    case "ゲーム開始":
      return replyText(replyToken, [`bro you're in a game rn`]);

    case "詳しく教えてください。":
      return replyText(replyToken, [
        `(必要であれば、プレーヤーにゲームを説明してあげて)`,
      ]);

    case "再送":
      return await sendQuestion(replyToken, stage);

    case "ヒント":
      const time_start = gameData.progress.at(-1);
      const time_diff = Date.now() - time_start;
      const hints = Array.isArray(questionData.hint)
        ? questionData.hint
        : [questionData.hint];

      if (time_diff < 10000) {
        return replyText(replyToken, [
          `Please wait another ${Math.ceil(
            (10000 - time_diff) / 1000
          )} seconds`,
        ]);
      } else {
        return replyText(replyToken, hints);
      }

    default:
      if (!stage) {
        switch (message.text) {
          case "easy":
            await proceedNextStage(source.userId);
            return await sendQuestion(replyToken, stage + 1);
          case "hard":
            await proceedNextStage(source.userId);
            return await sendQuestion(replyToken, stage + 1);
          case "online":
            await proceedNextStage(source.userId);
            return await sendQuestion(replyToken, stage + 1);
          default:
            return await replyText(replyToken, "just pick one");
        }
      }

      if (message.text === questionData.answer) {
        //proceed to the next stage
        const res = await proceedNextStage(source.userId);

        if (res) {
          if (stage === questions.length - 1) {
            endGame(source.userId).then((data) => {
              const { time, wrong } = data;
              const congrats = flex_messages.congrats;
              congrats.body.contents[0].text = time;
              congrats.body.contents[1].text = `Wrong Answers: ${wrong}`;
              return sendFlexMessage(
                replyToken,
                congrats,
                `Congratulations! You completed the challenge in ${time} with ${wrong} wrong answer${
                  wrong > 1 ? "s" : ""
                }`
              );
            });
          } else {
            return await sendQuestion(replyToken, stage + 1);
          }
        }
      } else {
        updateWrong(key);
        return await replyText(replyToken, "Wrong answers");
      }
  }
}

function handleImage(message, replyToken) {
  let getContent;
  if (message.contentProvider.type === "line") {
    const downloadPath = path.join(
      path.resolve(),
      "downloaded",
      `${message.id}.jpg`
    );
    const previewPath = path.join(
      path.resolve(),
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
      path.resolve(),
      "downloaded",
      `${message.id}.mp4`
    );
    const previewPath = path.join(
      path.resolve(),
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
      path.resolve(),
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
