import { initializeApp } from "firebase/app";
import {
  getDatabase,
  ref,
  set,
  get,
  child,
  push,
  serverTimestamp,
  update,
  remove,
  increment,
} from "firebase/database";

import dotenv from "dotenv";
dotenv.config();

import { questions, flex_messages } from "./questions.js";

// TODO: Replace with your app's Firebase project configuration
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  // The value of `databaseURL` depends on the location of the database
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};

export const firebaseApp = initializeApp(firebaseConfig);

// Get a reference to the database service
export const database = getDatabase(firebaseApp);

export async function writeUserData(userId, data) {
  return await set(ref(database, "users/" + userId), data);
}

export async function newGameData(userId, mode = 0) {
  const game = await push(ref(database, "games/"), {
    uid: userId,
    wrong: 0,
    mode,
    progress: [serverTimestamp()],
    hint: [0],
  });

  const key = game.key;
  const res = await update(ref(database, `users/${userId}`), {
    current_game: key,
  });

  return res;
}

export async function updateGameData(gameId, data) {
  const res = await update(ref(database, `games/${gameId}`), data);

  return res;
}

export async function updateUserData(userId, data) {
  const res = await update(ref(database, `users/${userId}`), data);

  return res;
}

const dbRef = ref(database);

export async function getGameByGameId(game_key) {
  const snapshot = await get(child(dbRef, `games/${game_key}`));

  if (snapshot.exists()) {
    return { data: snapshot.val() };
  } else {
    throw new Error("No data available");
  }
}
export async function getUserCurrentGame(userId) {
  const { data } = await getUserData(userId);
  const game_key = data.current_game;
  const { data: gameData } = await getGameByGameId(game_key);
  return { data: gameData, key: game_key };
}

export async function getUserData(userId) {
  const snapshot = await get(child(dbRef, `users/${userId}`));

  if (snapshot.exists()) {
    return { data: snapshot.val() };
  } else {
    throw new Error("No data available");
  }
}

export async function removeUserData(userId) {
  const res = await remove(child(dbRef, `users/${userId}`));

  return res;
}

export async function proceedNextStage(userId) {
  const { data, key } = await getUserCurrentGame(userId);
  const { hint, progress } = data;
  const stage = progress.length;
  progress.push(serverTimestamp());
  hint.push(0);

  const res = await updateGameData(key, {
    progress,
    hint,
  });

  return { data: res, stage: stage };
}

export async function proceedToMenu(userId, menu_stage = -1) {
  let stage;
  if (menu_stage < 0) stage = increment(1);
  else stage = menu_stage;

  const res = await update(ref(database, `users/${userId}`), {
    menu_stage: stage,
  });

  return { data: res };
}

function parseTime(number) {
  const ret = number.toString();
  if (ret.length === 1) {
    return "0" + ret;
  }
  return ret;
}



export async function endGame(userId) {
  const { data: gameData } = await getUserCurrentGame(userId);
  const { data: userData } = await getUserData(userId);
  await update(ref(database, `users/${userId}`), {
    current_game: null,
  });
// stage === questions[mode].length - 1
  if (gameData.progress.length < questions[gameData.mode].length) return;

  let time = gameData.progress.at(-1) - gameData.progress.at(-1);

  switch (gameData.mode) {
    case 0:
      if (!userData.hardFinish)
        updateUserData(userId, {
          hardFinish: gameData.progress.at(-1),
          hardTime: gameData.progress.at(-1) - userData.hardStart
        })
      time = gameData.progress.at(-1) - userData.hardStart;
    break;
    case 1:
      if (!userData.easyFinish)
        updateUserData(userId, {
          easyFinish: gameData.progress.at(-1),
          easyTime: gameData.progress.at(-1) - userData.easyStart
        })
      time = gameData.progress.at(-1) - userData.easyStart
    break;
    case 2:
      if (!userData.onlineFinish)
        updateUserData(userId, {
          onlineFinish: gameData.progress.at(-1),
          onlineTime: gameData.progress.at(-1) - userData.onlineStart
        })
      time = gameData.progress.at(-1) - userData.onlineStart
    break;
  }

  const hours = Math.floor(time / 60000 / 60);
  const minutes = Math.floor(time / 60000) - 60 * hours;
  const seconds = Math.floor(time / 1000) - 60 * minutes;
  const TIMER = `${hours > 0 ? parseTime(hours) + ":" : ""}${parseTime(
    minutes
  )}:${parseTime(seconds)}`;

  return { time: TIMER, wrong: gameData.wrong };
}

export async function updateWrong(gameId) {
  const res = updateGameData(gameId, {
    wrong: increment(1),
  });

  return res;
}

export async function useHint(gameId) {
  const { data } = await getGameByGameId(gameId);
  const { hint } = data;

  hint[hint.length - 1] += 1;
  const res = updateGameData(gameId, {
    hint,
  });

  return res;
}
