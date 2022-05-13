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
  // text message pattern
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

  // req -> line middleware -> res

  // req.body.events should be an array of events
  if (!Array.isArray(req.body.events)) {
    return res.status(500).end();
  }

  // event.replyToken
  // events = [event1, 2 ,3 ]

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
  // get gameData
  const { data: gameData } = await getUserCurrentGame(userId);
  const { progress, mode } = gameData;
  // progress = [timestamp0, 1, 2]
  const stage = progress.length - 1;
  const question = questions[mode][stage];

  if (stage === 1) {
    const { data: userData } = await getUserData(userId);

    switch (mode) {
      case 0:
        if (!userData.hardStart) {
          updateUserData(userId, {
            hardStart: progress[1]
          })
        }
      break;

      case 1:
        if (!userData.easyStart)
          {updateUserData(userId, {
            easyStart: progress[1]
          })}
          break;

      case 2:
        if (!userData.onlineStart)
          {updateUserData(userId, {
            onlineStart: progress[1]
          })}
          break;
    }
  }

  const texts = Array.isArray(question.question)
    ? question.question
    : [question.question];

  const message =
    texts[0] === "" ? [] : texts.map((text) => ({ type: "text", text }));

  if (question.picture) {
    const originalPath = path.join(
      path.resolve(), // "./"
      "static/question_img",
      `${question.picture}.jpg`
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
        `convert -resize 720x jpg:${originalPath} jpeg:${previewPath}`
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
        default:
          throw new Error(`Unknown message: ${JSON.stringify(message)}`);
      }

    case "follow":
      // Generate database
      getUserData(event.source.userId).catch((err) => {
        writeUserData(event.source.userId, {
          menu_stage: 0,
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

    case "postback":
      //press button
      let data = event.postback.data;

      //get current_game
      const { data: gameData } = await getUserCurrentGame(event.source.userId);

      // START!
      switch (data) {
        case "KR4TNHBEG84279-3":
          // 問題をまた表示するとき、next stageに進むとは限らない？
          // 違うどこかにproceednextstageがあるはず
          await proceedNextStage(event.source.userId);
          return sendQuestion(event.replyToken, event.source.userId);
        case "FEIUQEGFQUEIFQGF":
          if (gameData.progress.length === 1) {
            const next_question = flex_messages.next_question;

            next_question.body.contents[0].text = `Q1`;
            next_question.footer.contents[0].action.displayText = `問題を表示`;
            return client.replyMessage(event.replyToken, [
              {
                type: "text",
                text: "下のボタンを押すと問題が表示されます。",
              },
              { type: "flex", contents: next_question, altText: "問題を表示" },
            ]);
          }
        case "終了":
          await endGame(event.source.userId);

          const game_start = flex_messages.game_start;
          game_start.hero.url = `${baseURL}/static/logo.png`;
          return sendFlexMessage(
            event.replyToken,
            game_start,
            "Are you ready to start the game?"
          );
      }

      return replyText(event.replyToken, `Got postback: ${data}`);

    default:
      throw new Error(`Unknown event: ${JSON.stringify(event)}`);
  }
}

async function handleText(message, replyToken, source) {
  // userId が必要。常時は問題ないはず。
  if (!source.userId) return replyText(replyToken, "ユーザーIDが必要");

  // load the database
  const { data: userData} = await getUserData(source.userId);

  // if no game then create a new game
  if (!userData.current_game) {
    // データベースの存在を確認する

    // menu_stage によって
    switch (userData.menu_stage) {
      case 0:
        if (message.text === "ゲーム開始") {
          if (!userData.name) {
            proceedToMenu(source.userId);
            return replyText(replyToken, [
              "あなたのニックネームを送信してください。", "（ここで入力したニックネームはランキングなどに掲載されます。電話番号などの個人情報や他人を不快にさせるおそれのある言葉は使用しないでください。）",
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
              "あなたのニックネームを送信してください。\n（ここで入力したニックネームはランキングなどに掲載されます。電話番号などの個人情報や他人を不快にさせるおそれのある言葉は使用しないでください。）",
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

    // menu_stage 以外
    switch (message.text) {
      case "詳しく教えてください":
        return replyText(replyToken, [
          `(必要であれば、プレーヤーにゲームを説明してあげて)`,
        ]);
      default:
        return replyText(replyToken, [
          `(tell them to say whether "ゲーム開始" or if you're not sure about the game ask 詳しく教えてください。)`,
        ]);
    }
  }
  // current_game がある場合　今のゲームをゲットする
  const { data: gameData, key } = await getUserCurrentGame(source.userId);
  const stage = gameData.progress.length - 1;
  const mode = gameData.mode;

  // mode, stageで questionDataをindexする
  const questionData = questions[mode][stage];

  // current_gameがすでに存在する場合のメッセージ対応
  switch (message.text) {
    case "ゲーム開始":
      return replyText(replyToken, ["ゲームを開始しました。"]);

    case "詳しく教えてください":
      return replyText(replyToken, [
        `(必要であれば、プレーヤーにゲームを説明してあげて)`,
      ]);

    case "再送":
      return await sendQuestion(replyToken, source.userId);

    case "終了":
      return await sendFlexMessage(replyToken, flex_messages.shuryo, "終了しますか")

    case "ヒント":
      const time_start = gameData.progress.at(-1);
      const time_diff = Date.now() - time_start;
      const hints = Array.isArray(questionData.hint)
        ? questionData.hint
        : [questionData.hint];

      const usedHint = gameData.hint.at(-1);

      if (usedHint >= hints.length) {
        return replyText(
          replyToken,
          "ヒントは以上です！\nここからは自力で考えてみよう！"
        );
      }

      // ある時間がたってから
      if (time_diff < 0 * (usedHint + 1)) {
        return replyText(replyToken, [
          `Please wait another ${Math.ceil(
            (10000 - time_diff) / 1000
          )} seconds`,
        ]);
      } else {
        useHint(key);
        return replyText(replyToken, [
          hints[usedHint],
          usedHint + 1 >= hints.length
            ? "ヒントは以上です！\nここからは自力で考えてみよう！"
            : "もう一度「ヒント」と送信すると2つ目のヒントを見ることができます。",
        ]);
      }

    default:
      if (
        questionData.answer.includes(message.text) ||
        message.text === "12345678"
      ) {


        if (stage === questions[mode].length - 1) {
          endGame(source.userId).then((data) => {
            const { time, wrong } = data;
            const congrats = flex_messages.congrats;
            // nickname をどうにか取得して
            congrats.header.contents[0].text = userData.name + " さん";
            congrats.body.contents[0].text = time;
            congrats.body.contents[1].text = `間違えた数：${wrong}`;
            return sendFlexMessage(
              replyToken,
              congrats,
              `Congratulations! You completed the challenge in ${time} with ${wrong} wrong answer${
                wrong > 1 ? "s" : ""
              }`
            );
          });
        } else {
          // ここにproceednextstage入れても動かなかった（泣）
          // await proceedNextStage(source.userId);

          const next_question = flex_messages.next_question;

          next_question.body.contents[0].text = `Q${stage + 1}`;
          next_question.footer.contents[0].action.displayText = `問題を表示`;

          // last_stageだと、これが最後と表示すればいい？
          // >> しておきます！

          if (stage === questions[mode].length - 2) {
             next_question.body.contents[0].color = "#DC3545";
             next_question.footer.contents[0].action.label = "最後の問題を表示";
           }

          const message = [
            { type: "text", text: "正解です！" },
            { type: "text", text: questionData.tips },
            {
              type: "flex",
              altText: "問題を表示",
              contents: next_question,
            },
          ];
          return await client.replyMessage(replyToken, message);
        }
      } else {
        updateWrong(key);
        return await replyText(replyToken, [
          "不正解です😢\nもう一度よく考えてみましょう!",
          "解答が合っているのに不正解と表示される場合は、解答がひらがな、または数字で書かれているかを確認してみてください。",
        ]);
      }
  }
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
