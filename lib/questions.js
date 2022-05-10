import fs from "fs";

const rawData = fs.readFileSync("./static/questions.json");
export const { questions } = JSON.parse(rawData);

export const { flex_messages } = JSON.parse(
  fs.readFileSync("./static/flex_messages.json")
);
