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
} from "firebase/database";
import dotenv from "dotenv";
dotenv.config();

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

export const keyGen = (length) => {
  const lower = "qwertyuiopasdfghjklzxcvbnm";
  const number = "7410852963";
  const joined = [lower, number].join("");
  let ret = "";
  for (let i = 0; i < length; i++) {
    ret += joined[Math.floor(Math.random() * (joined.length + 1))];
  }

  return ret;
};

export async function newGameData(userId, stage = 0, last_stage = null) {
  const created_at = serverTimestamp();
  let first_created_at;
  if (stage !== 0) {
    const { data } = await getGameByGameId(last_stage);
    first_created_at = data.first_created_at;
  } else {
    first_created_at = created_at;
  }
  const game = await push(ref(database, "games/"), {
    uid: userId,
    created_at: created_at,
    stage: stage,
    last_stage: last_stage,
    first_created_at: first_created_at,
  });

  const key = game.key;
  const res = await update(ref(database, `users/${userId}`), {
    current_game: key,
  });

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

  return await getGameByGameId(game_key);
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
  const { data: gameData } = await getUserCurrentGame(userId);
  const { data: userData } = await getUserData(userId);
  const last_stage = userData.current_game;
  const stage = gameData.stage + 1;
  await newGameData(userId, stage, last_stage);

  return { data: { stage } };
}

export async function endGame(userId) {
  const { data: gameData } = await getUserCurrentGame(userId);
  const { data: userData } = await getUserData(userId);
  const time = gameData.created_at - gameData.first_created_at;
  if (!userData.best_time || time < userData.best_time) {
    await update(ref(database, `users/${userId}`), {
      best_time: time,
    });
  }
  if (!userData.first_finish) {
    await update(ref(database, `users/${userId}`), {
      first_finish: gameData.created_at,
    });
  }
  await update(ref(database, `users/${userId}`), {
    current_game: null,
  });
  const minutes = Math.floor(time / 60000);
  const seconds = Math.floor(time / 1000) - 60 * minutes;
  const TIMER =
    minutes > 0 ? `${minutes}.${seconds} minutes` : `${seconds} seconds`;

  return TIMER;
}
