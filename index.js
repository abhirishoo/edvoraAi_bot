// index.js
const TelegramBot = require("node-telegram-bot-api");
const dotenv = require("dotenv");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pdfParse = require("pdf-parse");
const fetch = require("node-fetch");

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!TELEGRAM_TOKEN || !GEMINI_KEY) {
  console.error("Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY in .env");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ---- State (per chat) ----
const state = new Map();
function S(chatId) {
  if (!state.has(chatId)) state.set(chatId, { mode: "idle", followUps: 0 });
  return state.get(chatId);
}
function reset(chatId) { state.set(chatId, { mode: "idle", followUps: 0 }); }

// ---- Strip markdown/bold ----
function removeMarkdown(text) {
  return text.replace(/(\*|_|`|\~)/g, "");
}

// ---- UI helpers ----
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "/mock" }, { text: "/plan" }],
      [{ text: "/resume" }, { text: "/help" }, { text: "/cancel" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

// ---- Register commands ----
bot.setMyCommands([
  { command: "start", description: "Welcome and profile setup" },
  { command: "mock", description: "Get AI-generated interview question" },
  { command: "plan", description: "Get your 10-day personalized prep plan" },
  { command: "resume", description: "Upload a PDF for review" },
  { command: "explain", description: "Explain the last question" },
  { command: "help", description: "How to use the bot" },
  { command: "cancel", description: "Reset session" }
]).catch(() => {});

// ---- Start & Profiling ----
bot.onText(/\/start/, (msg) => {
  reset(msg.chat.id);
  const chatId = msg.chat.id;
  const s = S(chatId);
  s.mode = "awaiting_name";
  bot.sendMessage(chatId, "Welcome to AI Career Mentor! Let's create your profile.\nWhat's your name?");
});

// ---- Help ----
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Quick help:\n" +
    "- /start → set up profile & personalized prep\n" +
    "- /mock → get AI-generated interview question\n" +
    "- /plan → get personalized 10-day prep plan\n" +
    "- /resume → upload PDF for review\n" +
    "- /explain → explanation of last question\n" +
    "- /cancel → reset session",
    mainKeyboard
  );
});

// ---- Cancel ----
bot.onText(/\/cancel/, (msg) => {
  reset(msg.chat.id);
  bot.sendMessage(msg.chat.id, "Session cleared.", mainKeyboard);
});

// ---- Resume upload ----
bot.onText(/\/resume/, (msg) => {
  reset(msg.chat.id);
  bot.sendMessage(msg.chat.id, "Send your resume as a PDF file (under 5MB).");
});

bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;
  if (!doc || !/pdf$/i.test(doc.mime_type || "")) return bot.sendMessage(chatId, "Please upload a PDF.");
  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const res = await fetch(fileLink);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = (await pdfParse(buf)).text.slice(0, 20000);
    const out = await model.generateContent(
      `You are a recruiter. Review this resume text briefly.\nGive 3 strengths and 3 fixes. No bold. Keep under 120 words.\n\n${text}`
    );
    bot.sendMessage(chatId, "Resume review:\n" + removeMarkdown(out.response.text()));
  } catch (e) {
    bot.sendMessage(chatId, "Error reading resume.");
  }
});

// ---- Mock question ----
bot.onText(/\/mock/, (msg) => {
  const chatId = msg.chat.id;
  const s = S(chatId);
  if (!s.role) {
    s.mode = "awaiting_role_for_mock";
    return bot.sendMessage(chatId, "To generate a question, which role are you preparing for?");
  }
  generateQuestion(chatId, s.role);
});

// ---- Plan ----
bot.onText(/\/plan/, (msg) => {
  const chatId = msg.chat.id;
  const s = S(chatId);
  if (!s.name || !s.role) {
    s.mode = "awaiting_profile_for_plan";
    return bot.sendMessage(chatId, "To create a personalized plan, let's first know your role.");
  }
  generatePrepPlan(chatId, s);
});

// ---- Explain last question ----
bot.onText(/\/explain/, async (msg) => {
  const chatId = msg.chat.id;
  const s = S(chatId);
  if (!s.lastQuestion) return bot.sendMessage(chatId, "No question yet. Use /mock first.");
  try {
    const r = await model.generateContent(
      `Explain this interview question clearly and briefly.\nQuestion: ${s.lastQuestion}\nKeep under 120 words.`
    );
    bot.sendMessage(chatId, "Explanation:\n" + removeMarkdown(r.response.text()));
  } catch (e) {
    bot.sendMessage(chatId, "Error generating explanation.");
  }
});

// ---- Generic message handler ----
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  const s = S(chatId);

  switch (s.mode) {
    case "awaiting_name":
      s.name = text;
      s.mode = "awaiting_role";
      return bot.sendMessage(chatId, `Hi ${text}! Which role are you preparing for?`);

    case "awaiting_role":
      s.role = text;
      s.mode = "awaiting_experience";
      return bot.sendMessage(chatId, "How many years of experience do you have?");

    case "awaiting_experience":
      s.experience = text;
      s.mode = "awaiting_strengths";
      return bot.sendMessage(chatId, "List your strengths (comma separated).");

    case "awaiting_strengths":
      s.strengths = text.split(",").map(x => x.trim());
      s.mode = "awaiting_weaknesses";
      return bot.sendMessage(chatId, "List your weaknesses (comma separated).");

    case "awaiting_weaknesses":
      s.weaknesses = text.split(",").map(x => x.trim());
      s.mode = "idle";
      return generatePrepPlan(chatId, s);

    case "awaiting_role_for_mock":
      s.role = text;
      s.mode = "idle";
      return generateQuestion(chatId, s.role);

    case "awaiting_profile_for_plan":
      s.role = text;
      s.mode = "idle";
      return generatePrepPlan(chatId, s);

    case "awaiting_answer":
      s.lastAnswer = text;
      s.mode = "idle";
      giveFeedbackAndFollowUp(chatId);
      break;
  }
});

// ---- Functions ----
async function generateQuestion(chatId, role) {
  const s = S(chatId);
  try {
    const r = await model.generateContent(
      `You are an expert interviewer. Generate 1 challenging, user-specific interview question for the following candidate:\n` +
      `Name: ${s.name}\nRole: ${role}\nExperience: ${s.experience}\n` +
      `Strengths: ${s.strengths.join(", ")}\nWeaknesses: ${s.weaknesses.join(", ")}\n` +
      `Make the question relevant to their strengths and address improvement areas. Keep it concise. No bold.`
    );
    const question = removeMarkdown(r.response.text());
    s.mode = "awaiting_answer";
    s.lastQuestion = question;
    s.lastAnswer = undefined;
    s.followUps = 0;
    bot.sendMessage(chatId, "Mock question:\n\n" + question + "\n\nReply with your answer.");
  } catch {
    bot.sendMessage(chatId, "Error generating personalized question.");
  }
}

async function giveFeedbackAndFollowUp(chatId) {
  const s = S(chatId);
  try {
    const r = await model.generateContent(
      `You are a strict interviewer. Review the candidate's answer briefly and suggest a relevant follow-up question.\n` +
      `Question: ${s.lastQuestion}\nAnswer: ${s.lastAnswer}\n` +
      `Return 3 short pros, 3 short improvements, and 1 follow-up question. No bold.`
    );
    const feedbackText = removeMarkdown(r.response.text());
    bot.sendMessage(chatId, "Feedback:\n" + feedbackText);

    // Generate follow-up question if under 3 follow-ups
    if (s.followUps < 1) {
      const followUpR = await model.generateContent(
        `Based on the previous answer, generate 1 follow-up interview question for the candidate.\n` +
        `Name: ${s.name}\nRole: ${s.role}\nExperience: ${s.experience}\n` +
        `Strengths: ${s.strengths.join(", ")}\nWeaknesses: ${s.weaknesses.join(", ")}\n` +
        `Keep it concise and user-specific. No bold.`
      );
      const followUpQ = removeMarkdown(followUpR.response.text());
      s.lastQuestion = followUpQ;
      s.lastAnswer = undefined;
      s.mode = "awaiting_answer";
      s.followUps++;
      bot.sendMessage(chatId, "\nFollow-up question:\n" + followUpQ + "\n\nReply with your answer or type /cancel to stop.");
    } else {
      bot.sendMessage(chatId, "\nMini-interview session completed. Type /mock to start again.", mainKeyboard);
    }
  } catch {
    bot.sendMessage(chatId, "Error generating feedback/follow-up.");
  }
}

async function generatePrepPlan(chatId, s) {
  try {
    const r = await model.generateContent(
      `Create a 10-day personalized interview prep plan for the following candidate:\n` +
      `Name: ${s.name}\nRole: ${s.role}\nExperience: ${s.experience}\n` +
      `Strengths: ${s.strengths.join(", ")}\nWeaknesses: ${s.weaknesses.join(", ")}\n` +
      `Include daily topics, tasks, and mock questions. Keep it concise. No bold.`
    );
    bot.sendMessage(chatId, "Here's your personalized prep plan:\n\n" + removeMarkdown(r.response.text()), mainKeyboard);
  } catch {
    bot.sendMessage(chatId, "Error generating prep plan.");
  }
}

console.log("🤖 AI Career Mentor bot is running...");
