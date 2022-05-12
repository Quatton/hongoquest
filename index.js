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
  proceedToMenu,
  updateUserData,
  useHint,
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
    type: "image",
    originalContentUrl:
      "https://hongoquest.herokuapp.com/static/question_img/stage1.jpg",
    previewImageUrl:
      "https://hongoquest.herokuapp.com/static/question_img/stage1-preview.jpg",
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
      console.error(err.response);
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

const sendQuestion = async (token, userId) => {
  const { data: gameData } = await getUserCurrentGame(userId);
  const { progress, mode } = gameData;
  const stage = progress.length - 1;
  const question = questions[mode][stage];
  const texts = Array.isArray(question.question)
    ? question.question
    : [question.question];
  const message =
    texts[0] === "" ? [] : texts.map((text) => ({ type: "text", text }));
  if (stage > 1) message.unshift({ type: "text", text: "正解です！" });
  if (question.picture) {
    const originalPath = path.join(
      path.resolve(),
      "static/question_img",
      `${question.picture}.png`
    );
    const previewPath = path.join(
      path.resolve(),
      "static/question_img",
      `${question.picture}-preview.jpg`
    );

    const originalContentUrl =
      baseURL + "/static/question_img/" + path.basename(originalPath);
    const previewImageUrl =
      baseURL + "/static/question_img/" + path.basename(previewPath);

    if (!fs.existsSync(previewPath)) {
      cp.execSync(
        `convert -resize 720x png:${originalPath} jpeg:${previewPath}`
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
async function handleEvent(event) {
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
            menu_stage: 0,
          });
        });
      });

      const game_start = flex_messages.game_start;
      game_start.hero.url = `${baseURL}/static/logo.png`;
      return sendFlexMessage(
        event.replyToken,
        game_start,
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

      const { data: gameData } = await getUserCurrentGame(event.source.userId);
      if (data === "ゲーム開始") {
        if (gameData.progress.length > 1)
          return replyText(replyToken, [`Game started`]);
        await proceedNextStage(event.source.userId);
        return sendQuestion(event.replyToken, event.source.userId);
      }

      return replyText(event.replyToken, `Got postback: ${data}`);

    case "beacon":
      return replyText(event.replyToken, `Got beacon: ${event.beacon.hwid}`);

    default:
      throw new Error(`Unknown event: ${JSON.stringify(event)}`);
  }
}

async function handleText(message, replyToken, source) {
  // userId が必要。常時は問題ないはず。
  if (!source.userId) return replyText(replyToken, "ユーザーIDが必要");

  // load the database
  const userData = await getUserData(source.userId);
  const { data } = userData;

  if (!data.current_game) {
    // データベースの存在を確認する

    switch (data.menu_stage) {
      case 0:
        if (message.text === "ゲーム開始") {
          if (!data.name) {
            proceedToMenu(source.userId);
            return replyText(replyToken, [
              "まずはじめに、あなたのニックネームを送信してください。",
              "（ここで入力したニックネームはランキングなどに掲載されます。電話番号などの個人情報や他人を不快にさせるおそれのある言葉は使用しないでください。)",
            ]);
          } else {
            proceedToMenu(source.userId, 3);
            return sendFlexMessage(replyToken, flex_messages.place);
          }
        }
      case 1:
        const nickname_confirm = flex_messages.nickname;
        const name = message.text.slice(0, 32);
        nickname_confirm.body.contents[1].text = name;
        proceedToMenu(source.userId);
        updateUserData(source.userId, {
          name: name,
        });
        return sendFlexMessage(replyToken, nickname_confirm);
      case 2:
        switch (message.text) {
          case "はい":
            proceedToMenu(source.userId);
            return sendFlexMessage(replyToken, flex_messages.place);
          case "入力し直す":
            proceedToMenu(source.userId, 1);
            return replyText(replyToken, [
              "まずはじめに、あなたのニックネームを送信してください。",
              "（ここで入力したニックネームはランキングなどに掲載されます。電話番号などの個人情報や他人を不快にさせるおそれのある言葉は使用しないでください。）",
            ]);
          default:
            return replyText(replyToken, [
              "【はい】か【入力し直す】をお選びください。",
            ]);
        }
      case 3:
        switch (message.text) {
          case "キャンパス":
            proceedToMenu(source.userId);
            return sendFlexMessage(replyToken, flex_messages.difficulty);
          case "オンライン":
            proceedToMenu(source.userId, 0);
            newGameData(source.userId, 2);
            return sendFlexMessage(replyToken, flex_messages.start_confirm);
          default:
            return replyText(replyToken, [
              "【キャンパス】か【オンライン】をお選びください。",
            ]);
        }
      case 4:
        switch (message.text) {
          case "難しい":
            proceedToMenu(source.userId, 0);
            newGameData(source.userId, 0);
            return sendFlexMessage(replyToken, flex_messages.start_confirm);
          case "普通":
            proceedToMenu(source.userId, 0);
            newGameData(source.userId, 1);
            return sendFlexMessage(replyToken, flex_messages.start_confirm);
          default:
            return replyText(replyToken, [
              "【難しい】か【普通】をお選びください。",
            ]);
        }
    }

    switch (message.text) {
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
  const mode = gameData.mode;

  const questionData = questions[mode][stage];
  console.log(questionData.answer);

  switch (message.text) {
    case "ゲーム開始":
      return replyText(replyToken, [
        `(how do i tell them that they are in a game rn?)`,
      ]);

    case "START!":
      console.log("it's counted");
      return;
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

      const usedHint = gameData.hint.at(-1);

      if (usedHint >= hints.length) {
        return replyText(replyToken, "もうないよ");
      }
      if (time_diff < 10000 * (usedHint + 1)) {
        return replyText(replyToken, [
          `Please wait another ${Math.ceil(
            (10000 - time_diff) / 1000
          )} seconds`,
        ]);
      } else {
        useHint(key);
        return replyText(replyToken, hints[usedHint]);
      }

    default:
      if (
        questionData.answer.includes(message.text) ||
        message.text === "12345678"
      ) {
        //proceed to the next stagedownloaded
        await proceedNextStage(source.userId);
        if (stage === questions[mode].length - 1) {
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
          return await sendQuestion(replyToken, source.userId);
        }
      } else {
        updateWrong(key);
        return await replyText(replyToken, [
          "不正解です😢\nもう一度よく考えてみましょう！",

          "答えが合っているのに不正解と表示される場合は、解答がひらがな、または数字で書かれているか確認してみてください。",
        ]);
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
