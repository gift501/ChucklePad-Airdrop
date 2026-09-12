require("dotenv").config();

const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const session = require("express-session");

const {
    createClient
} = require("@supabase/supabase-js");

const app = express();

app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;


const requiredEnvironment = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SESSION_SECRET",
    "GEMINI_API_KEY"
];

for (const variable of requiredEnvironment) {

    if (!process.env[variable]) {

        throw new Error(
            `Missing environment variable: ${variable}`
        );

    }

}


const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-3.6-flash";


const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    }
);


const supabaseAuth = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    }
);


function createUserSupabaseClient(accessToken) {

    if (!accessToken) {
        return null;
    }

    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
                detectSessionInUrl: false
            },
            global: {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }
        }
    );

}


app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    })
);


const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === "/api/rocket/tick",
    handler: (req, res) => {

        if (req.path.startsWith("/api/")) {

            return res.status(429).json({
                success: false,
                error: "Too many requests. Please slow down."
            });

        }

        return res.status(429).send(
            "Too many requests. Please try again later."
        );

    }
});

app.use(generalLimiter);


const huntLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {

        return res.status(429).json({
            success: false,
            error: "Too many requests. Please wait a few minutes."
        });

    }
});


app.use(
    (req, res, next) => {

        res.locals.appName = "ChucklePad";
        res.locals.tokenSymbol = "$CPAD";
        res.locals.user = req.session.user || null;

        next();

    }
);


function requireAuth(req, res, next) {

    if (!req.session.user) {

        if (req.path.startsWith("/api/")) {

            return res.status(401).json({
                success: false,
                error: "Authentication required."
            });

        }

        return res.redirect("/login");

    }

    next();

}


function getCurrentHeistWeek() {

    const now = new Date();
    const day = now.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;

    const weekStart = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - daysSinceMonday
        )
    );

    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    return {
        weekStart: weekStart.toISOString().slice(0, 10),
        weekEnd: weekEnd.toISOString().slice(0, 10)
    };

}


async function getOrCreateCurrentHeist() {

    const { weekStart, weekEnd } = getCurrentHeistWeek();

    const { data: existing, error: findError } =
        await supabaseAdmin
            .from("weekly_heists")
            .select(`
                id,
                week_start,
                week_end,
                prize_pool,
                status,
                created_at,
                closed_at,
                updated_at
            `)
            .eq("week_start", weekStart)
            .maybeSingle();

    if (findError) throw findError;

    if (existing) return existing;

    const { data: created, error: createError } =
        await supabaseAdmin
            .from("weekly_heists")
            .insert({
                week_start: weekStart,
                week_end: weekEnd,
                prize_pool: 1000000,
                status: "open"
            })
            .select(`
                id,
                week_start,
                week_end,
                prize_pool,
                status,
                created_at,
                closed_at,
                updated_at
            `)
            .single();

    if (!createError) return created;

    if (createError.code === "23505") {

        const { data: retry, error: retryError } =
            await supabaseAdmin
                .from("weekly_heists")
                .select(`
                    id,
                    week_start,
                    week_end,
                    prize_pool,
                    status,
                    created_at,
                    closed_at,
                    updated_at
                `)
                .eq("week_start", weekStart)
                .single();

        if (retryError) throw retryError;

        return retry;

    }

    throw createError;

}


async function settleHeistIfFinished(heist) {

    const weekEnd = new Date(`${heist.week_end}T00:00:00.000Z`);
    const now = new Date();

    if (now < weekEnd) return heist;
    if (heist.status === "completed") return heist;

    const { data: settlementResult, error: settlementError } =
        await supabaseAdmin
            .rpc("settle_weekly_heist", {
                p_heist_id: heist.id
            });

    if (settlementError) {

        console.error("Weekly Heist settlement error:", settlementError);
        throw settlementError;

    }

    console.log("WEEKLY HEIST SETTLEMENT:", settlementResult);

    const { data: updatedHeist, error: updatedHeistError } =
        await supabaseAdmin
            .from("weekly_heists")
            .select(`
                id,
                week_start,
                week_end,
                prize_pool,
                status,
                created_at,
                closed_at,
                updated_at
            `)
            .eq("id", heist.id)
            .single();

    if (updatedHeistError) throw updatedHeistError;

    return updatedHeist;

}


function escapeHtml(value) {

    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

}


async function callGeminiStructured({ prompt, schema, temperature = 0.7 }) {

    const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            body: JSON.stringify({
                model: GEMINI_MODEL,
                input: prompt,
                store: false,
                generation_config: {
                    temperature,
                    max_output_tokens: 1000
                },
                response_format: {
                    type: "text",
                    mime_type: "application/json",
                    schema
                }
            })
        }
    );

    const responseText = await response.text();

    let data;

    try {

        data = JSON.parse(responseText);

    } catch {

        console.error("Gemini returned non-JSON HTTP response:", responseText);
        throw new Error("Gemini returned an invalid response.");

    }

    if (!response.ok) {

        console.error("Gemini API error:", data);

        throw new Error(
            data?.error?.message || "Gemini API request failed."
        );

    }

    let text = data?.output_text;

    if (!text && Array.isArray(data?.steps)) {

        const modelOutputStep =
            data.steps.find((step) => step?.type === "model_output");

        if (modelOutputStep && Array.isArray(modelOutputStep.content)) {

            const textPart =
                modelOutputStep.content.find((part) => part?.type === "text");

            if (textPart) text = textPart.text;

        }

    }

    if (!text) {

        console.error(
            "Gemini response contained no usable model output:",
            data
        );

        throw new Error("Gemini returned no usable content.");

    }

    try {

        return JSON.parse(text);

    } catch {

        console.error("Gemini returned malformed JSON:", text);
        throw new Error("Gemini returned malformed JSON.");

    }

}


async function generateDailyHuntQuestion() {

    const categories = [
        "education",
        "humanity",
        "charity",
        "agriculture",
        "food security",
        "community development"
    ];

    const category =
        categories[Math.floor(Math.random() * categories.length)];

    const prompt = `
You are the Daily Hunt question generator for ChucklePad.

ChucklePad is a community-driven project focused on:

- education
- humanity
- charity
- agriculture
- food security
- positive community development

Generate ONE thoughtful Daily Hunt question.

Today's category:
${category}

Requirements:

1. The question must encourage genuine thinking or a practical idea.
2. It must be answerable without specialist knowledge.
3. It must not require current news.
4. It must not require political opinions.
5. It must not involve religion.
6. It must not involve sexual content.
7. It must not involve medical diagnosis or treatment.
8. It must not involve investment, cryptocurrency prices, gambling,
   or promises of financial returns.
9. It must not ask the user to donate money.
10. It should be understandable to an international audience.
11. The expected answer should normally be 2–6 sentences.
12. Do not ask for a supporting link.
13. Do not include the answer.
14. Do not include markdown.
15. Return only the requested JSON structure.
`;

    const schema = {
        type: "object",
        properties: {
            category: { type: "string" },
            question: { type: "string" }
        },
        required: ["category", "question"]
    };

    const result =
        await callGeminiStructured({ prompt, schema, temperature: 0.9 });

    const cleanCategory =
        String(result.category || category).trim().slice(0, 100);

    const question =
        String(result.question || "").trim();

    if (question.length < 20 || question.length > 1000) {

        throw new Error("Gemini generated an invalid Hunt question.");

    }

    return { category: cleanCategory, question };

}


async function evaluateHuntAnswer({ question, answer }) {

    const prompt = `
You are the impartial evaluator for a ChucklePad Daily Hunt.

DAILY HUNT QUESTION:
${question}

USER ANSWER:
${answer}

Evaluate the answer according to these rules.

A valid answer:

- directly addresses the question;
- demonstrates genuine effort;
- contains a relevant idea, explanation, example, or practical suggestion;
- is not merely random text;
- is not just copied filler;
- does not need to be factually perfect when the question asks for an opinion
  or practical idea;
- does not need perfect grammar.

An invalid answer:

- is empty or meaningless;
- is obvious spam;
- is unrelated to the question;
- consists mainly of repeated characters;
- attempts to manipulate the scoring system;
- contains only a few meaningless words.

Scoring:

90–100:
Excellent, thoughtful, relevant and useful.

75–89:
Strong and clearly relevant.

50–74:
Reasonably relevant but limited or underdeveloped.

1–49:
Some relevance or effort, but weak.

0:
Invalid, meaningless, spam, or completely unrelated.

Do not punish spelling or grammar heavily.

Return ONLY the requested JSON.
`;

    const schema = {
        type: "object",
        properties: {
            valid: { type: "boolean" },
            score: { type: "integer", minimum: 0, maximum: 100 },
            reasoning: { type: "string" }
        },
        required: ["valid", "score", "reasoning"]
    };

    const result =
        await callGeminiStructured({ prompt, schema, temperature: 0.2 });

    let score = Number(result.score);

    if (!Number.isFinite(score)) score = 0;

    score = Math.round(Math.max(0, Math.min(100, score)));

    const valid = Boolean(result.valid);

    if (answer.trim().length < 20) {

        return {
            valid: false,
            score: 0,
            reasoning:
                "The answer is too short to demonstrate meaningful participation."
        };

    }

    if (!valid) score = 0;

    return {
        valid: valid && score > 0,
        score,
        reasoning:
            String(result.reasoning || "").trim().slice(0, 2000)
    };

}


app.get("/", (req, res) => {

    res.render("home", {
        title: "ChucklePad — Laugh. Participate. Earn. Give Back."
    });

});


app.get("/register", (req, res) => {

    if (req.session.user) return res.redirect("/dashboard");

    res.render("register", {
        title: "Join ChucklePad",
        error: null,
        form: {}
    });

});


app.post("/register", async (req, res) => {

    const {
        first_name,
        last_name,
        username,
        country,
        display_name,
        email,
        password,
        confirm_password,
        referral_code,
        genesis_code
    } = req.body;

    const form = {
        first_name,
        last_name,
        username,
        country,
        display_name,
        email,
        referral_code,
        genesis_code
    };

    if (
        !first_name ||
        !last_name ||
        !username ||
        !country ||
        !email ||
        !password ||
        !confirm_password
    ) {

        return res.status(400).render("register", {
            title: "Join ChucklePad",
            error: "Please complete all required fields.",
            form
        });

    }

    if (password !== confirm_password) {

        return res.status(400).render("register", {
            title: "Join ChucklePad",
            error: "Passwords do not match.",
            form
        });

    }

    if (password.length < 8) {

        return res.status(400).render("register", {
            title: "Join ChucklePad",
            error: "Password must contain at least 8 characters.",
            form
        });

    }

    const usernamePattern = /^[A-Za-z0-9_]+$/;

    if (
        username.length < 3 ||
        username.length > 30 ||
        !usernamePattern.test(username)
    ) {

        return res.status(400).render("register", {
            title: "Join ChucklePad",
            error:
                "Username must be 3–30 characters and contain only letters, numbers, and underscores.",
            form
        });

    }

    try {

        const { data, error } =
            await supabaseAdmin.auth.admin.createUser({
                email: email.trim().toLowerCase(),
                password,
                email_confirm: true,
                user_metadata: {
                    first_name: first_name.trim(),
                    last_name: last_name.trim(),
                    display_name: display_name ? display_name.trim() : null
                }
            });

        if (error) {

            console.error("Supabase registration error:", error);

            return res.status(400).render("register", {
                title: "Join ChucklePad",
                error: `Supabase error: ${error.message}`,
                form
            });

        }

        const userId = data.user.id;

        const { data: registrationResult, error: registrationError } =
            await supabaseAdmin.rpc("complete_registration_v2", {
                p_user_id: userId,
                p_first_name: first_name.trim(),
                p_last_name: last_name.trim(),
                p_username: username.trim(),
                p_country: country.trim(),
                p_display_name: display_name ? display_name.trim() : null,
                p_referral_code: referral_code
                    ? referral_code.trim().toUpperCase()
                    : null,
                p_genesis_code: genesis_code ? genesis_code.trim() : null
            });

        if (registrationError) {

            console.error("Registration reward error:", registrationError);

            await supabaseAdmin.auth.admin.deleteUser(userId);

            return res.status(400).render("register", {
                title: "Join ChucklePad",
                error: `Registration error: ${registrationError.message}`,
                form
            });

        }

        const { data: loginData, error: loginError } =
            await supabaseAuth.auth.signInWithPassword({
                email: email.trim().toLowerCase(),
                password
            });

        if (loginError) {

            console.error("Post-registration login error:", loginError);

            return res.status(400).render("register", {
                title: "Join ChucklePad",
                error:
                    `Account created, but automatic login failed: ${loginError.message}`,
                form
            });

        }

        req.session.user = {
            id: userId,
            email: email.trim().toLowerCase(),
            accessToken: loginData.session.access_token
        };

        return res.redirect("/dashboard");

    } catch (error) {

        console.error("Registration failure:", error);

        return res.status(500).render("register", {
            title: "Join ChucklePad",
            error: `Registration failure: ${error.message}`,
            form
        });

    }

});


app.get("/login", (req, res) => {

    if (req.session.user) return res.redirect("/dashboard");

    res.render("login", {
        title: "Login",
        error: null
    });

});


app.post("/login", async (req, res) => {

    const { email, password } = req.body;

    if (!email || !password) {

        return res.status(400).render("login", {
            title: "Login",
            error: "Email and password are required."
        });

    }

    try {

        const { data, error } =
            await supabaseAuth.auth.signInWithPassword({
                email: email.trim().toLowerCase(),
                password
            });

        if (error) {

            console.error("Login error:", error);

            return res.status(401).render("login", {
                title: "Login",
                error: "Invalid email or password."
            });

        }

        req.session.user = {
            id: data.user.id,
            email: data.user.email,
            accessToken: data.session.access_token
        };

        return res.redirect("/dashboard");

    } catch (error) {

        console.error("Login failure:", error);

        return res.status(500).render("login", {
            title: "Login",
            error: "Unable to log in right now."
        });

    }

});


app.post("/logout", (req, res) => {

    req.session.destroy(() => res.redirect("/"));

});


app.get("/logout", (req, res) => {

    req.session.destroy(() => res.redirect("/"));

});


app.get("/dashboard", requireAuth, async (req, res) => {

    try {

        const sessionUser = req.session.user;

        if (!sessionUser) return res.redirect("/login");

        const supabaseUser =
            createUserSupabaseClient(sessionUser.accessToken);

        if (!supabaseUser) return res.redirect("/login");

        const { data: profile, error } =
            await supabaseUser
                .from("profiles")
                .select(`
                    id,
                    first_name,
                    last_name,
                    username,
                    country,
                    display_name,
                    referral_code,
                    points,
                    tickets,
                    streak_days,
                    genesis_eligible,
                    created_at
                `)
                .eq("id", sessionUser.id)
                .maybeSingle();

        if (error) {

            console.error("Dashboard profile query failed:", error);
            return res.status(500).send("Unable to load your profile.");

        }

        if (!profile) {

            return res.status(404).send(
                "Your account exists, but your ChucklePad profile could not be found."
            );

        }

        res.render("dashboard", {
            title: "Dashboard",
            profile
        });

    } catch (error) {

        console.error("Dashboard error:", error);
        res.status(500).send("Unable to load dashboard.");

    }

});


app.post("/api/daily-signin", requireAuth, async (req, res) => {

    try {

        const { data, error } =
            await supabaseAdmin.rpc("claim_daily_signin", {
                p_user_id: req.session.user.id
            });

        if (error) {

            console.error("Daily signin RPC error:", error);

            return res.status(400).json({
                success: false,
                error: error.message
            });

        }

        return res.json({
            success: true,
            result: data
        });

    } catch (error) {

        console.error("Daily signin error:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to process Daily Sign-In."
        });

    }

});


app.get("/whitepaper", (req, res) => {

    res.render("whitepaper", {
        title: "ChucklePad — White Paper V1"
    });

});


app.get("/hunt", requireAuth, async (req, res) => {

    try {

        const today =
            new Date().toISOString().slice(0, 10);

        let { data: hunt, error: huntError } =
            await supabaseAdmin
                .from("daily_hunts")
                .select(`
                    id,
                    hunt_date,
                    question,
                    supporting_link_required,
                    active
                `)
                .eq("hunt_date", today)
                .eq("active", true)
                .maybeSingle();

        if (huntError) throw huntError;

        if (!hunt) {

            const generated = await generateDailyHuntQuestion();

            const { data: createdHunt, error: createError } =
                await supabaseAdmin
                    .from("daily_hunts")
                    .insert({
                        hunt_date: today,
                        question: generated.question,
                        supporting_link_required: false,
                        active: true
                    })
                    .select(`
                        id,
                        hunt_date,
                        question,
                        supporting_link_required,
                        active
                    `)
                    .single();

            if (createError) {

                const { data: existingHunt } =
                    await supabaseAdmin
                        .from("daily_hunts")
                        .select(`
                            id,
                            hunt_date,
                            question,
                            supporting_link_required,
                            active
                        `)
                        .eq("hunt_date", today)
                        .eq("active", true)
                        .maybeSingle();

                if (!existingHunt) throw createError;

                hunt = existingHunt;

            } else {

                hunt = createdHunt;

            }

        }

        const { data: previousSubmission, error: submissionLookupError } =
            await supabaseAdmin
                .from("hunt_submissions")
                .select(`
                    id,
                    ai_score,
                    ai_reasoning,
                    tickets_awarded,
                    points_awarded,
                    validation_status,
                    submitted_at,
                    evaluated_at
                `)
                .eq("hunt_id", hunt.id)
                .eq("user_id", req.session.user.id)
                .maybeSingle();

        if (submissionLookupError) throw submissionLookupError;

        let resultHtml = "";

        if (previousSubmission) {

            resultHtml = `

                <div class="result-card">

                    <div class="result-label">
                        HUNT COMPLETED
                    </div>

                    <div class="score">

                        ${escapeHtml(previousSubmission.ai_score ?? 0)}

                        <span>/100</span>

                    </div>

                    <p>

                        ${escapeHtml(
                            previousSubmission.ai_reasoning ||
                            "Your submission has been evaluated."
                        )}

                    </p>

                    <div class="reward-grid">

                        <div>

                            <strong>

                                ${escapeHtml(previousSubmission.points_awarded)}

                            </strong>

                            <span>
                                Points
                            </span>

                        </div>

                        <div>

                            <strong>

                                ${escapeHtml(previousSubmission.tickets_awarded)}

                            </strong>

                            <span>
                                Tickets
                            </span>

                        </div>

                    </div>

                </div>

            `;

        }

        const formHtml =
            previousSubmission
                ? ""
                : `

                <form
                    method="POST"
                    action="/api/daily-hunt/submit"
                    class="hunt-form"
                >

                    <label for="answer">
                        Your answer
                    </label>

                    <textarea
                        id="answer"
                        name="answer"
                        minlength="20"
                        maxlength="2000"
                        required
                        placeholder="Share your thoughts, idea, solution, or practical suggestion..."
                    ></textarea>

                    <div class="counter">
                        Minimum 20 characters
                    </div>

                    <button type="submit">
                        SUBMIT HUNT
                    </button>

                </form>

            `;

        res.send(`

<!DOCTYPE html>

<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>
        ChucklePad — Daily Hunt
    </title>

    <style>

        * { box-sizing: border-box; }

        body {

            margin: 0;

            min-height: 100vh;

            background: #0b0b0d;

            color: #f5f5f5;

            font-family:
                Arial,
                Helvetica,
                sans-serif;

        }

        a { color: inherit; text-decoration: none; }

        .nav {

            display: flex;

            align-items: center;

            justify-content: space-between;

            gap: 20px;

            padding: 20px 6%;

            border-bottom: 1px solid #252529;

        }

        .brand { font-weight: 900; letter-spacing: -0.04em; }

        .brand span { opacity: 0.55; margin-left: 6px; }

        .back { opacity: 0.7; }

        .container {

            width: min(900px, 92%);

            margin: 70px auto;

        }

        .eyebrow {

            display: inline-block;

            padding: 8px 12px;

            border: 1px solid #38383e;

            border-radius: 999px;

            font-size: 12px;

            font-weight: 800;

            letter-spacing: 0.12em;

        }

        h1 {

            font-size: clamp(42px, 8vw, 82px);

            line-height: 0.92;

            letter-spacing: -0.07em;

            margin: 24px 0;

        }

        .intro {

            color: #a9a9b2;

            font-size: 18px;

            line-height: 1.6;

            max-width: 700px;

        }

        .hunt-card {

            margin-top: 45px;

            padding: clamp(25px, 5vw, 55px);

            border: 1px solid #303038;

            border-radius: 30px;

            background: #121216;

            box-shadow: 10px 10px 0 #050506;

        }

        .category {

            color: #ff8a00;

            font-size: 13px;

            font-weight: 900;

            letter-spacing: 0.15em;

            text-transform: uppercase;

        }

        .question {

            margin: 22px 0 35px;

            font-size: clamp(25px, 4vw, 42px);

            line-height: 1.12;

            letter-spacing: -0.035em;

        }

        .hunt-form label {

            display: block;

            margin-bottom: 10px;

            font-weight: 800;

        }

        textarea {

            width: 100%;

            min-height: 210px;

            resize: vertical;

            padding: 18px;

            border: 1px solid #3a3a42;

            border-radius: 18px;

            outline: none;

            background: #09090b;

            color: #fff;

            font: inherit;

            line-height: 1.6;

        }

        textarea:focus { border-color: #ff8a00; }

        .counter {

            margin: 10px 0 20px;

            color: #777780;

            font-size: 13px;

        }

        button {

            width: 100%;

            padding: 17px 20px;

            border: 0;

            border-radius: 15px;

            background: #ff8a00;

            color: #09090b;

            font-weight: 900;

            cursor: pointer;

        }

        button:hover { transform: translateY(-2px); }

        .result-card {

            margin-top: 25px;

            padding: 25px;

            border: 1px solid #303038;

            border-radius: 22px;

            background: #0c0c0f;

        }

        .result-label {

            color: #ff8a00;

            font-size: 12px;

            font-weight: 900;

            letter-spacing: 0.12em;

        }

        .score {

            margin: 15px 0;

            font-size: 65px;

            font-weight: 900;

            letter-spacing: -0.06em;

        }

        .score span { color: #686871; font-size: 20px; }

        .result-card p { color: #b4b4bd; line-height: 1.6; }

        .reward-grid {

            display: grid;

            grid-template-columns: repeat(2, 1fr);

            gap: 15px;

            margin-top: 25px;

        }

        .reward-grid div {

            padding: 20px;

            border: 1px solid #292930;

            border-radius: 16px;

        }

        .reward-grid strong { display: block; font-size: 28px; }

        .reward-grid span { color: #777780; font-size: 13px; }

        .footer {

            padding: 50px 6%;

            color: #686871;

            text-align: center;

        }

        @media (max-width: 600px) {

            .container { margin: 40px auto; }

            .reward-grid { grid-template-columns: 1fr; }

        }

    </style>

</head>

<body>

    <nav class="nav">

        <a href="/" class="brand">
            CHUCKLEPAD
            <span>$CPAD</span>
        </a>

        <a href="/dashboard" class="back">
            ← Dashboard
        </a>

    </nav>

    <main class="container">

        <div class="eyebrow">
            DAILY CHALLENGE
        </div>

        <h1>
            Think.<br>
            Participate.<br>
            Give back.
        </h1>

        <p class="intro">

            One question every day.
            Share a genuine idea and earn
            Points and Tickets for participating.

        </p>

        <section class="hunt-card">

            <div class="category">
                TODAY'S CHUCKLE HUNT
            </div>

            <div class="question">

                ${escapeHtml(hunt.question)}

            </div>

            ${formHtml}

            ${resultHtml}

        </section>

    </main>

    <footer class="footer">

        ChucklePad —
        Laugh. Participate. Earn. Give Back.

    </footer>

</body>

</html>

        `);

    } catch (error) {

        console.error("Daily Hunt page error:", error);
        res.status(500).send("Unable to load today's Daily Hunt.");

    }

});


app.post("/api/daily-hunt/submit", requireAuth, huntLimiter, async (req, res) => {

    try {

        const userId = req.session.user.id;

        const answer = String(req.body.answer || "").trim();

        if (answer.length < 20) {

            return res.status(400).send(
                "Your answer is too short. Please provide a meaningful response."
            );

        }

        if (answer.length > 2000) {

            return res.status(400).send(
                "Your answer is too long. Please keep it under 2,000 characters."
            );

        }

        const today =
            new Date().toISOString().slice(0, 10);

        const { data: hunt, error: huntError } =
            await supabaseAdmin
                .from("daily_hunts")
                .select(`
                    id,
                    question,
                    active
                `)
                .eq("hunt_date", today)
                .eq("active", true)
                .maybeSingle();

        if (huntError) throw huntError;

        if (!hunt) {

            return res.status(404).send(
                "Today's Daily Hunt is not available."
            );

        }

        const { data: existing } =
            await supabaseAdmin
                .from("hunt_submissions")
                .select("id")
                .eq("hunt_id", hunt.id)
                .eq("user_id", userId)
                .maybeSingle();

        if (existing) {

            return res.status(409).send(
                "You have already completed today's Daily Hunt."
            );

        }

        const { data: submission, error: submissionError } =
            await supabaseAdmin
                .from("hunt_submissions")
                .insert({
                    hunt_id: hunt.id,
                    user_id: userId,
                    answer,
                    validation_status: "pending"
                })
                .select("id")
                .single();

        if (submissionError) {

            if (submissionError.code === "23505") {

                return res.status(409).send(
                    "You have already completed today's Daily Hunt."
                );

            }

            throw submissionError;

        }

        let evaluation;

        try {

            evaluation = await evaluateHuntAnswer({
                question: hunt.question,
                answer
            });

        } catch (geminiError) {

            console.error("Gemini Hunt evaluation error:", geminiError);

            await supabaseAdmin
                .from("hunt_submissions")
                .delete()
                .eq("id", submission.id);

            return res.status(503).send(
                "Automatic Hunt evaluation is temporarily unavailable. Please try again later."
            );

        }

        let score = Number(evaluation.score);

        if (!Number.isFinite(score)) score = 0;

        score = Math.round(Math.max(0, Math.min(100, score)));

        const reasoning =
            String(evaluation.reasoning || "").trim().slice(0, 2000);

        const { data: rewardResult, error: rewardError } =
            await supabaseAdmin.rpc("complete_daily_hunt", {
                p_submission_id: submission.id,
                p_user_id: userId,
                p_ai_score: score,
                p_ai_reasoning: reasoning
            });

        if (rewardError) {

            console.error("Daily Hunt reward error:", rewardError);

            return res.status(500).send(
                "The Hunt was evaluated, but the reward could not be finalized."
            );

        }

        console.log("DAILY HUNT REWARD RESULT:", rewardResult);

        return res.redirect("/hunt");

    } catch (error) {

        console.error("Daily Hunt submission error:", error);
        return res.status(500).send(
            "Unable to process your Daily Hunt submission."
        );

    }

});


app.get("/api/health", async (req, res) => {

    try {

        const { error } =
            await supabaseAdmin
                .from("profiles")
                .select("id")
                .limit(1);

        if (error) throw error;

        return res.json({
            success: true,
            application: "ChucklePad",
            database: "connected",
            gemini: GEMINI_MODEL
        });

    } catch (error) {

        console.error("Health check error:", error);

        return res.status(500).json({
            success: false,
            database: "error"
        });

    }

});


async function getRocketState(userId) {

    const today =
        new Date().toISOString().slice(0, 10);

    const { data: attempts, error } =
        await supabaseAdmin
            .from("rocket_attempts")
            .select(`
                id,
                attempt_number,
                status,
                flight_time,
                crash_time,
                points_awarded,
                started_at,
                finished_at
            `)
            .eq("user_id", userId)
            .eq("attempt_date", today)
            .order("attempt_number", { ascending: true });

    if (error) throw error;

    const rows = attempts || [];

    const resolved =
        rows.filter(
            (a) => a.status === "cashed_out" || a.status === "crashed"
        );

    const pointsToday =
        resolved.reduce(
            (sum, a) => sum + Number(a.points_awarded || 0),
            0
        );

    const pending =
        rows.find((a) => a.status === "created") || null;

    const remainingCap =
        Math.max(0, 15000 - pointsToday);

    return {
        today,
        attempts: rows,
        resolved_count: resolved.length,
        points_today: pointsToday,
        remaining_cap: remainingCap,
        can_start:
            resolved.length < 3 &&
            !pending &&
            remainingCap > 0,
        pending_attempt_id: pending ? pending.id : null
    };

}


app.get("/rocket", requireAuth, async (req, res) => {

    try {

        const userId = req.session.user.id;

        const state = await getRocketState(userId);

        const { data: leaderboard } =
            await supabaseAdmin
                .from("rocket_weekly_leaderboard")
                .select("*")
                .limit(10);

        const { data: feed } =
            await supabaseAdmin
                .from("rocket_feed")
                .select(`
                    username,
                    flight_time,
                    crash_time,
                    points_awarded,
                    status,
                    finished_at
                `)
                .limit(20);

        const feedRows =
            (feed || [])
                .map(
                    (row) => {

                        const label =
                            row.status === "cashed_out"
                                ? `cashed out at ${Number(row.flight_time).toFixed(1)}s`
                                : `crashed at ${Number(row.crash_time).toFixed(1)}s`;

                        const points =
                            row.points_awarded > 0
                                ? `+${row.points_awarded} pts`
                                : "0 pts";

                        return `
                            <div class="feed-row">
                                <span class="feed-user">
                                    ${escapeHtml(row.username || "anon")}
                                </span>
                                <span class="feed-action">
                                    ${escapeHtml(label)}
                                </span>
                                <span class="feed-points ${row.points_awarded > 0 ? "win" : ""}">
                                    ${escapeHtml(points)}
                                </span>
                            </div>
                        `;

                    }
                )
                .join("");

        const leaderboardRows =
            (leaderboard || [])
                .map(
                    (row, index) => `
                        <div class="lb-row">
                            <span class="lb-rank">#${index + 1}</span>
                            <span class="lb-user">
                                ${escapeHtml(row.username || "anon")}
                            </span>
                            <span class="lb-pts">
                                ${escapeHtml(Number(row.weekly_points || 0).toLocaleString())}
                            </span>
                        </div>
                    `
                )
                .join("");

        const remainingAttempts =
            3 - state.resolved_count;

        res.send(`

<!DOCTYPE html>

<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>
        ChucklePad — Rocket Rush
    </title>

    <style>

        * { box-sizing: border-box; }

        body {

            margin: 0;

            min-height: 100vh;

            background: #07070a;

            color: #f5f5f5;

            font-family: Arial, Helvetica, sans-serif;

        }

        a { color: inherit; text-decoration: none; }

        .nav {

            display: flex;

            align-items: center;

            justify-content: space-between;

            gap: 20px;

            padding: 20px 6%;

            border-bottom: 1px solid #252529;

        }

        .brand { font-weight: 900; letter-spacing: -0.04em; }

        .brand span { opacity: 0.5; margin-left: 6px; }

        .back { color: #a7a7b0; }

        .container {

            width: min(1100px, 92%);

            margin: 50px auto 90px;

        }

        .eyebrow {

            display: inline-block;

            padding: 8px 12px;

            border: 1px solid #3a3a42;

            border-radius: 999px;

            font-size: 11px;

            font-weight: 900;

            letter-spacing: 0.15em;

        }

        h1 {

            margin: 25px 0 15px;

            font-size: clamp(48px, 9vw, 100px);

            line-height: 0.9;

            letter-spacing: -0.075em;

        }

        .intro {

            max-width: 700px;

            color: #a7a7b0;

            font-size: 18px;

            line-height: 1.6;

        }

        .game-card {

            margin-top: 45px;

            padding: clamp(25px, 5vw, 50px);

            border: 1px solid #303038;

            border-radius: 30px;

            background: #101014;

            box-shadow: 10px 10px 0 #030304;

            position: relative;

            overflow: hidden;

        }

        .rocket-stage {

            position: relative;

            height: 260px;

            border: 1px solid #292930;

            border-radius: 20px;

            background:
                radial-gradient(
                    ellipse at bottom,
                    #181820 0%,
                    #0a0a0d 60%
                );

            overflow: hidden;

        }

        .rocket-track {

            position: absolute;

            inset: 0;

            background-image:
                linear-gradient(
                    to top,
                    transparent 0%,
                    rgba(255,255,255,0.03) 50%,
                    transparent 100%
                );

        }

        .rocket {

            position: absolute;

            left: 50%;

            bottom: 20px;

            transform: translateX(-50%);

            font-size: 42px;

            transition: bottom 0.1s linear, transform 0.1s linear;

            user-select: none;

        }

        .rocket.flying {

            animation: rocket-shake 0.15s infinite alternate;

        }

        @keyframes rocket-shake {

            from { margin-left: -2px; }
            to   { margin-left: 2px; }

        }

        .rocket.crashed {

            filter: grayscale(1) brightness(0.4);

            transform: translateX(-50%) rotate(180deg);

        }

        .flight-readout {

            position: absolute;

            top: 20px;

            left: 20px;

            font-size: 13px;

            color: #a7a7b0;

            font-weight: 700;

            letter-spacing: 0.08em;

        }

        .flight-value {

            margin-top: 6px;

            font-size: 42px;

            font-weight: 900;

            letter-spacing: -0.05em;

            color: #ff8a00;

        }

        .flight-reward {

            position: absolute;

            top: 20px;

            right: 20px;

            text-align: right;

        }

        .flight-reward-label {

            font-size: 11px;

            color: #777780;

            font-weight: 900;

            letter-spacing: 0.12em;

        }

        .flight-reward-value {

            margin-top: 6px;

            font-size: 34px;

            font-weight: 900;

            letter-spacing: -0.05em;

        }

        .controls {

            margin-top: 30px;

            display: grid;

            grid-template-columns: 1fr;

            gap: 15px;

        }

        button {

            width: 100%;

            padding: 20px;

            border: 0;

            border-radius: 16px;

            font: inherit;

            font-weight: 900;

            cursor: pointer;

            transition: transform 0.1s ease;

        }

        button:disabled { opacity: 0.4; cursor: not-allowed; }

        .btn-start { background: #ff8a00; color: #07070a; }

        .btn-cashout { background: #1ed760; color: #07070a; }

        .btn-cashout:disabled { background: #2a2a30; color: #6c6c75; }

        button:not(:disabled):hover { transform: translateY(-2px); }

        .state-grid {

            margin-top: 30px;

            display: grid;

            grid-template-columns: repeat(3, 1fr);

            gap: 15px;

        }

        .state-cell {

            padding: 20px;

            border: 1px solid #292930;

            border-radius: 18px;

            background: #0c0c10;

        }

        .state-cell strong {

            display: block;

            font-size: 28px;

            letter-spacing: -0.04em;

        }

        .state-cell span {

            display: block;

            margin-top: 4px;

            color: #777780;

            font-size: 12px;

            letter-spacing: 0.08em;

            font-weight: 700;

        }

        .result-banner {

            margin-top: 25px;

            padding: 22px;

            border: 1px solid #303038;

            border-radius: 20px;

            background: #0c0c10;

            display: none;

        }

        .result-banner.visible { display: block; }

        .result-banner.win { border-color: #1ed760; }

        .result-banner.loss { border-color: #ff3d3d; }

        .result-title {

            font-size: 12px;

            font-weight: 900;

            letter-spacing: 0.14em;

        }

        .result-banner.win .result-title { color: #1ed760; }

        .result-banner.loss .result-title { color: #ff3d3d; }

        .result-points {

            margin-top: 8px;

            font-size: 42px;

            font-weight: 900;

            letter-spacing: -0.05em;

        }

        .result-meta {

            margin-top: 8px;

            color: #a7a7b0;

            font-size: 14px;

            line-height: 1.6;

        }

        .social-grid {

            margin-top: 55px;

            display: grid;

            grid-template-columns: 1.5fr 1fr;

            gap: 20px;

        }

        .panel {

            border: 1px solid #292930;

            border-radius: 22px;

            background: #0c0c10;

            overflow: hidden;

        }

        .panel-header {

            padding: 18px 22px;

            border-bottom: 1px solid #1f1f24;

            font-size: 12px;

            font-weight: 900;

            letter-spacing: 0.14em;

            color: #a7a7b0;

        }

        .panel-body {

            max-height: 420px;

            overflow-y: auto;

        }

        .feed-row, .lb-row {

            display: flex;

            align-items: center;

            justify-content: space-between;

            gap: 15px;

            padding: 14px 22px;

            border-bottom: 1px solid #1a1a1f;

            font-size: 14px;

        }

        .feed-row:last-child, .lb-row:last-child { border-bottom: 0; }

        .feed-user, .lb-user { color: #d8d8e0; font-weight: 700; }

        .feed-action {

            color: #777780;

            flex: 1;

            text-align: right;

            font-size: 13px;

        }

        .feed-points {

            color: #777780;

            font-weight: 900;

            min-width: 80px;

            text-align: right;

        }

        .feed-points.win { color: #1ed760; }

        .lb-rank {

            color: #ff8a00;

            font-weight: 900;

            min-width: 40px;

        }

        .lb-pts { color: #ff8a00; font-weight: 900; }

        .empty {

            padding: 25px 22px;

            color: #55555e;

            font-size: 13px;

        }

        .footer {

            padding: 50px 6%;

            color: #606069;

            text-align: center;

            border-top: 1px solid #1f1f24;

            margin-top: 60px;

        }

        @media (max-width: 700px) {

            .state-grid { grid-template-columns: 1fr; }

            .social-grid { grid-template-columns: 1fr; }

        }

    </style>

</head>

<body>

    <nav class="nav">

        <a href="/" class="brand">
            CHUCKLEPAD
            <span>$CPAD</span>
        </a>

        <a href="/dashboard" class="back">
            ← Dashboard
        </a>

    </nav>

    <main class="container">

        <div class="eyebrow">
            PROVABLY FAIR MINI-GAME
        </div>

        <h1>
            ROCKET<br>
            RUSH.
        </h1>

        <p class="intro">

            Three attempts a day.
            Fly as long as you dare.
            Cash out before the rocket crashes.
            The server commits to the crash point
            before your flight begins — verify every attempt.

        </p>

        <section class="game-card">

            <div class="rocket-stage">

                <div class="rocket-track"></div>

                <div class="flight-readout">
                    FLIGHT TIME
                    <div class="flight-value" id="flight-value">
                        0.0s
                    </div>
                </div>

                <div class="flight-reward">
                    <div class="flight-reward-label">
                        CASH OUT VALUE
                    </div>
                    <div class="flight-reward-value" id="reward-value">
                        0
                    </div>
                </div>

                <div class="rocket" id="rocket">
                    🚀
                </div>

            </div>

            <div class="controls">

                <button
                    class="btn-start"
                    id="btn-start"
                    ${state.can_start ? "" : "disabled"}
                >
                    ${state.can_start
                        ? `START ATTEMPT (${remainingAttempts} LEFT)`
                        : (state.pending_attempt_id
                            ? "ATTEMPT IN PROGRESS"
                            : "NO ATTEMPTS LEFT TODAY")}
                </button>

                <button
                    class="btn-cashout"
                    id="btn-cashout"
                    disabled
                >
                    CASH OUT
                </button>

            </div>

            <div class="result-banner" id="result-banner">

                <div class="result-title" id="result-title"></div>

                <div class="result-points" id="result-points"></div>

                <div class="result-meta" id="result-meta"></div>

            </div>

            <div class="state-grid">

                <div class="state-cell">
                    <strong id="pts-today">
                        ${escapeHtml(state.points_today)}
                    </strong>
                    <span>POINTS TODAY</span>
                </div>

                <div class="state-cell">
                    <strong id="remaining-cap">
                        ${escapeHtml(state.remaining_cap)}
                    </strong>
                    <span>REMAINING CAP</span>
                </div>

                <div class="state-cell">
                    <strong id="attempts-left">
                        ${escapeHtml(remainingAttempts)}
                    </strong>
                    <span>ATTEMPTS LEFT</span>
                </div>

            </div>

        </section>

        <section class="social-grid">

            <div class="panel">

                <div class="panel-header">
                    LIVE ROCKET FEED
                </div>

                <div class="panel-body" id="feed-body">

                    ${feedRows || `<div class="empty">No flights yet today. Be the first.</div>`}

                </div>

            </div>

            <div class="panel">

                <div class="panel-header">
                    WEEKLY ROCKET LEADERBOARD
                </div>

                <div class="panel-body">

                    ${leaderboardRows || `<div class="empty">No flights this week yet.</div>`}

                </div>

            </div>

        </section>

    </main>

    <footer class="footer">

        ChucklePad —
        Laugh. Participate. Earn. Give Back.

    </footer>

    <script>

    const MAX_FLIGHT = 60;

    const btnStart   = document.getElementById("btn-start");
    const btnCashout = document.getElementById("btn-cashout");
    const rocketEl   = document.getElementById("rocket");
    const flightEl   = document.getElementById("flight-value");
    const rewardEl   = document.getElementById("reward-value");
    const banner     = document.getElementById("result-banner");
    const bannerTitle= document.getElementById("result-title");
    const bannerPts  = document.getElementById("result-points");
    const bannerMeta = document.getElementById("result-meta");
    const ptsToday   = document.getElementById("pts-today");
    const remainingCapEl = document.getElementById("remaining-cap");
    const attemptsLeftEl = document.getElementById("attempts-left");
    const feedBody   = document.getElementById("feed-body");

    let attemptId       = ${state.pending_attempt_id ? `"${state.pending_attempt_id}"` : "null"};
    let flightStart     = null;
    let rafHandle       = null;
    let tickHandle      = null;
    let finished        = false;

    function generateClientSeed() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    function previewReward(t) {
        if (t < 15) return 0;
        if (t >= 60) return 5000;

        const table = [
            [15, 0], [20, 500], [25, 900], [30, 1400], [35, 2000],
            [40, 2700], [45, 3400], [50, 4100], [55, 4600], [60, 5000]
        ];

        for (let i = 0; i < table.length - 1; i++) {
            const [a, pa] = table[i];
            const [b, pb] = table[i + 1];
            if (t >= a && t <= b) {
                const p = (t - a) / (b - a);
                return Math.round(pa + (pb - pa) * p);
            }
        }
        return 0;
    }

    function setFlight(t, reward) {
        flightEl.textContent = Number(t).toFixed(1) + "s";
        rewardEl.textContent = Number(reward).toLocaleString();

        const stage = document.querySelector(".rocket-stage");
        const maxBottom = stage.clientHeight - rocketEl.clientHeight - 40;
        const pct = Math.min(1, t / MAX_FLIGHT);
        rocketEl.style.bottom = (20 + maxBottom * pct) + "px";
    }

    function showBanner({ win, title, points, meta }) {
        banner.classList.add("visible");
        banner.classList.remove("win", "loss");
        banner.classList.add(win ? "win" : "loss");
        bannerTitle.textContent = title;
        bannerPts.textContent   = points;
        bannerMeta.textContent  = meta;
    }

    function hideBanner() {
        banner.classList.remove("visible", "win", "loss");
    }

    function stopEverything() {
        finished = true;
        if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
        if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
        btnCashout.disabled = true;
    }

    function animate() {
        if (!flightStart || finished) return;

        const elapsed = (performance.now() - flightStart) / 1000;
        const t = Math.min(MAX_FLIGHT, elapsed);

        const remaining = Number(remainingCapEl.textContent);
        const raw = previewReward(t);
        const displayReward = Math.min(raw, remaining);

        setFlight(t, displayReward);

        if (t >= MAX_FLIGHT) {
            btnCashout.click();
            return;
        }

        rafHandle = requestAnimationFrame(animate);
    }

    function startPolling() {
        tickHandle = setInterval(async () => {
            if (!attemptId || finished) return;

            try {
                const res = await fetch(
                    "/api/rocket/tick?attempt_id=" +
                    encodeURIComponent(attemptId)
                );
                const data = await res.json();

                if (!data.success) return;

                if (data.resolved) {

                    stopEverything();

                    rocketEl.classList.remove("flying");
                    rocketEl.classList.add("crashed");

                    if (data.status === "crashed") {

                        setFlight(data.crash_time, 0);

                        showBanner({
                            win: false,
                            title: "CRASHED",
                            points: "0 pts",
                            meta:
                                "The rocket exploded at " +
                                Number(data.crash_time).toFixed(1) +
                                "s. Server seed: " +
                                (data.server_seed
                                    ? data.server_seed.slice(0, 16) + "…"
                                    : "hidden")
                        });

                    } else {

                        setFlight(data.flight_time, data.points_awarded);

                        showBanner({
                            win: true,
                            title: "CASHED OUT",
                            points: "+" + data.points_awarded + " pts",
                            meta:
                                "Flew " +
                                Number(data.flight_time).toFixed(1) +
                                "s."
                        });

                    }

                    attemptId = null;
                    refreshState();

                }

            } catch (err) {
                // silent — next tick will retry
            }

        }, 250);
    }

    btnStart.addEventListener("click", async () => {

        btnStart.disabled = true;
        btnCashout.disabled = true;
        hideBanner();
        finished = false;
        rocketEl.classList.remove("crashed");
        rocketEl.classList.add("flying");
        rocketEl.style.bottom = "20px";
        setFlight(0, 0);

        const clientSeed = generateClientSeed();

        try {

            const response = await fetch(
                "/api/rocket/start",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ client_seed: clientSeed })
                }
            );

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || "Unable to start attempt.");
            }

            attemptId = data.attempt_id;
            flightStart = performance.now();

            btnCashout.disabled = false;

            rafHandle = requestAnimationFrame(animate);
            startPolling();

        } catch (err) {

            console.error(err);
            rocketEl.classList.remove("flying");
            showBanner({
                win: false,
                title: "COULD NOT START",
                points: "",
                meta: err.message
            });
            btnStart.disabled = false;

        }

    });

    btnCashout.addEventListener("click", async () => {

        if (!attemptId || finished) return;

        stopEverything();

        const flightTime =
            Math.min(
                MAX_FLIGHT,
                (performance.now() - flightStart) / 1000
            );

        try {

            const response = await fetch(
                "/api/rocket/cashout",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        attempt_id: attemptId,
                        flight_time: flightTime
                    })
                }
            );

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || "Cash-out failed.");
            }

            rocketEl.classList.remove("flying");
            attemptId = null;

            if (data.outcome === "crashed") {

                rocketEl.classList.add("crashed");

                showBanner({
                    win: false,
                    title: "CRASHED",
                    points: "0 pts",
                    meta:
                        "The rocket exploded at " +
                        Number(data.crash_time).toFixed(1) +
                        "s. Server seed: " +
                        data.server_seed.slice(0, 16) +
                        "…"
                });

            } else {

                showBanner({
                    win: true,
                    title: data.capped ? "CASHED OUT (CAPPED)" : "CASHED OUT",
                    points: "+" + data.points_awarded + " pts",
                    meta:
                        "Flew " +
                        Number(data.flight_time).toFixed(1) +
                        "s. Reward: " +
                        data.raw_reward +
                        " pts" +
                        (data.capped ? " (daily cap applied)" : "") +
                        ". Server seed: " +
                        data.server_seed.slice(0, 16) +
                        "…"
                });

            }

            refreshState();

        } catch (err) {

            console.error(err);
            showBanner({
                win: false,
                title: "ERROR",
                points: "",
                meta: err.message
            });

        }

    });

    async function refreshState() {

        try {

            const response = await fetch("/api/rocket/state");
            const data = await response.json();

            if (!data.success) return;

            ptsToday.textContent = data.state.points_today;
            remainingCapEl.textContent = data.state.remaining_cap;

            const remaining = 3 - data.state.resolved_count;
            attemptsLeftEl.textContent = remaining;

            if (data.state.can_start) {
                btnStart.disabled = false;
                btnStart.textContent = "START ATTEMPT (" + remaining + " LEFT)";
            } else {
                btnStart.disabled = true;
                btnStart.textContent =
                    remaining <= 0
                        ? "NO ATTEMPTS LEFT TODAY"
                        : "ATTEMPT IN PROGRESS";
            }

            if (data.feed) {
                feedBody.innerHTML =
                    data.feed.length
                        ? data.feed.map((row) => {
                            const label =
                                row.status === "cashed_out"
                                    ? "cashed out at " + Number(row.flight_time).toFixed(1) + "s"
                                    : "crashed at " + Number(row.crash_time).toFixed(1) + "s";
                            const pts =
                                row.points_awarded > 0
                                    ? "+" + row.points_awarded + " pts"
                                    : "0 pts";
                            return '<div class="feed-row">' +
                                '<span class="feed-user">' + row.username + '</span>' +
                                '<span class="feed-action">' + label + '</span>' +
                                '<span class="feed-points ' + (row.points_awarded > 0 ? "win" : "") + '">' + pts + '</span>' +
                                '</div>';
                        }).join("")
                        : '<div class="empty">No flights yet today. Be the first.</div>';
            }

        } catch (err) {
            console.error("State refresh failed:", err);
        }

    }

    setInterval(refreshState, 20000);

    </script>

</body>

</html>

        `);

    } catch (error) {

        console.error("Rocket Rush page error:", error);
        res.status(500).send("Unable to load Rocket Rush.");

    }

});


app.post("/api/rocket/start", requireAuth, async (req, res) => {

    try {

        const userId = req.session.user.id;

        const clientSeed =
            String(req.body.client_seed || "").trim().slice(0, 128);

        if (clientSeed.length < 8) {

            return res.status(400).json({
                success: false,
                error: "Invalid client seed."
            });

        }

        const { data, error } =
            await supabaseAdmin.rpc("create_rocket_attempt", {
                p_user_id: userId,
                p_client_seed: clientSeed
            });

        if (error) {

            console.error("Rocket start error:", error);

            return res.status(400).json({
                success: false,
                error: error.message
            });

        }

        return res.json({
            success: true,
            attempt_id: data.attempt_id,
            attempt_number: data.attempt_number,
            server_seed_hash: data.server_seed_hash,
            client_seed: data.client_seed,
            nonce: data.nonce
        });

    } catch (error) {

        console.error("Rocket start failure:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to start attempt."
        });

    }

});


app.get("/api/rocket/tick", requireAuth, async (req, res) => {

    try {

        const userId = req.session.user.id;

        const attemptId =
            String(req.query.attempt_id || "").trim();

        if (!attemptId) {

            return res.status(400).json({
                success: false,
                error: "Missing attempt id."
            });

        }

        const { data: check, error: checkError } =
            await supabaseAdmin.rpc("check_rocket_attempt", {
                p_attempt_id: attemptId,
                p_user_id: userId
            });

        if (checkError) {

            return res.status(400).json({
                success: false,
                error: checkError.message
            });

        }

        if (check.resolved) {

            return res.json({
                success: true,
                resolved: true,
                status: check.status,
                flight_time: check.flight_time,
                crash_time: check.crash_time,
                points_awarded: check.points_awarded
            });

        }

        if (check.elapsed >= 60) {

            const { data: timeoutResult, error: timeoutError } =
                await supabaseAdmin.rpc("resolve_rocket_timeout", {
                    p_attempt_id: attemptId,
                    p_user_id: userId
                });

            if (timeoutError) {

                return res.status(400).json({
                    success: false,
                    error: timeoutError.message
                });

            }

            return res.json({
                success: true,
                resolved: true,
                status: timeoutResult.status,
                flight_time: timeoutResult.flight_time,
                crash_time: timeoutResult.crash_time,
                points_awarded: timeoutResult.points_awarded,
                server_seed: timeoutResult.server_seed,
                server_seed_hash: timeoutResult.server_seed_hash,
                client_seed: timeoutResult.client_seed,
                nonce: timeoutResult.nonce
            });

        }

        if (check.should_crash) {

            const { data: resolution, error: resolveError } =
                await supabaseAdmin.rpc("resolve_rocket_crash", {
                    p_attempt_id: attemptId,
                    p_user_id: userId
                });

            if (resolveError) {

                return res.status(400).json({
                    success: false,
                    error: resolveError.message
                });

            }

            return res.json({
                success: true,
                resolved: true,
                status: "crashed",
                flight_time: resolution.flight_time,
                crash_time: resolution.crash_time,
                points_awarded: 0,
                server_seed: resolution.server_seed,
                server_seed_hash: resolution.server_seed_hash,
                client_seed: resolution.client_seed,
                nonce: resolution.nonce
            });

        }

        return res.json({
            success: true,
            resolved: false,
            elapsed: check.elapsed
        });

    } catch (error) {

        console.error("Rocket tick error:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to check attempt."
        });

    }

});


app.post("/api/rocket/cashout", requireAuth, async (req, res) => {

    try {

        const userId = req.session.user.id;

        const attemptId =
            String(req.body.attempt_id || "").trim();

        const flightTime = Number(req.body.flight_time);

        if (!attemptId) {

            return res.status(400).json({
                success: false,
                error: "Missing attempt id."
            });

        }

        if (!Number.isFinite(flightTime) || flightTime < 0) {

            return res.status(400).json({
                success: false,
                error: "Invalid flight time."
            });

        }

        const { data, error } =
            await supabaseAdmin.rpc("complete_rocket_attempt", {
                p_attempt_id: attemptId,
                p_user_id: userId,
                p_flight: flightTime
            });

        if (error) {

            console.error("Rocket cashout error:", error);

            return res.status(400).json({
                success: false,
                error: error.message
            });

        }

        return res.json({ success: true, ...data });

    } catch (error) {

        console.error("Rocket cashout failure:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to complete attempt."
        });

    }

});


app.get("/api/rocket/state", requireAuth, async (req, res) => {

    try {

        const userId = req.session.user.id;

        const state = await getRocketState(userId);

        const { data: feed } =
            await supabaseAdmin
                .from("rocket_feed")
                .select(`
                    username,
                    flight_time,
                    crash_time,
                    points_awarded,
                    status,
                    finished_at
                `)
                .limit(20);

        return res.json({
            success: true,
            state,
            feed: feed || []
        });

    } catch (error) {

        console.error("Rocket state error:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to load Rocket state."
        });

    }

});


app.get("/referrals", requireAuth, async (req, res) => {

    try {

        const userId = req.session.user.id;

        const { data: profile, error: profileError } =
            await supabaseAdmin
                .from("profiles")
                .select(`
                    username,
                    referral_code,
                    points
                `)
                .eq("id", userId)
                .maybeSingle();

        if (profileError) throw profileError;

        const { data: referralRows, error: referralError } =
            await supabaseAdmin
                .from("referrals")
                .select(`
                    id,
                    referred_id,
                    referrer_reward,
                    created_at,
                    referred:profiles!referrals_referred_id_fkey (
                        username,
                        country,
                        points,
                        created_at
                    )
                `)
                .eq("referrer_id", userId)
                .order("created_at", { ascending: false });

        if (referralError) throw referralError;

        const { data: ledgerRows, error: ledgerError } =
            await supabaseAdmin
                .from("points_ledger")
                .select("amount")
                .eq("user_id", userId)
                .eq("reward_type", "referral");

        if (ledgerError) throw ledgerError;

        const totalReferralPoints =
            (ledgerRows || []).reduce(
                (sum, row) => sum + Number(row.amount || 0),
                0
            );

        const totalReferrals = (referralRows || []).length;

        const referralListHtml =
            (referralRows || [])
                .map((row) => {

                    const referred = row.referred || {};

                    const joined =
                        new Date(row.created_at).toISOString().slice(0, 10);

                    return `
                        <div class="referral-row">
                            <div class="referral-user">
                                <strong>
                                    ${escapeHtml(referred.username || "unknown")}
                                </strong>
                                <span>
                                    ${escapeHtml(referred.country || "—")}
                                </span>
                            </div>
                            <div class="referral-stats">
                                <span class="referral-points">
                                    +${escapeHtml(row.referrer_reward || 0)} pts
                                </span>
                                <span class="referral-date">
                                    ${escapeHtml(joined)}
                                </span>
                            </div>
                        </div>
                    `;

                })
                .join("");

        const emptyState =
            totalReferrals === 0
                ? `
                    <div class="empty-state">
                        <div class="empty-emoji">😂</div>
                        <h3>No referrals yet.</h3>
                        <p>
                            Share your code with friends.
                            When they register and use it,
                            you earn 1,000 Points — and so do they.
                        </p>
                    </div>
                `
                : "";

        res.send(`

<!DOCTYPE html>

<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>
        ChucklePad — Referrals
    </title>

    <style>

        * { box-sizing: border-box; }

        body {

            margin: 0;

            min-height: 100vh;

            background: #07070a;

            color: #f5f5f5;

            font-family: Arial, Helvetica, sans-serif;

        }

        a { color: inherit; text-decoration: none; }

        .nav {

            display: flex;

            align-items: center;

            justify-content: space-between;

            gap: 20px;

            padding: 20px 6%;

            border-bottom: 1px solid #252529;

        }

        .brand { font-weight: 900; letter-spacing: -0.04em; }

        .brand span { opacity: 0.5; margin-left: 6px; }

        .back { color: #a7a7b0; }

        .container {

            width: min(900px, 92%);

            margin: 50px auto 90px;

        }

        .eyebrow {

            display: inline-block;

            padding: 8px 12px;

            border: 1px solid #3a3a42;

            border-radius: 999px;

            font-size: 11px;

            font-weight: 900;

            letter-spacing: 0.15em;

        }

        h1 {

            margin: 25px 0 15px;

            font-size: clamp(42px, 8vw, 82px);

            line-height: 0.92;

            letter-spacing: -0.07em;

        }

        .intro {

            max-width: 650px;

            color: #a7a7b0;

            font-size: 18px;

            line-height: 1.6;

        }

        .code-card {

            margin-top: 45px;

            padding: clamp(25px, 5vw, 45px);

            border: 1px solid #303038;

            border-radius: 30px;

            background: #101014;

            box-shadow: 10px 10px 0 #030304;

            text-align: center;

        }

        .code-label {

            color: #777780;

            font-size: 12px;

            font-weight: 900;

            letter-spacing: 0.15em;

        }

        .code-value {

            margin: 20px 0;

            font-size: clamp(40px, 9vw, 82px);

            font-weight: 900;

            letter-spacing: 0.1em;

            color: #ff8a00;

            word-break: break-all;

            user-select: all;

        }

        .copy-btn {

            display: inline-block;

            padding: 14px 28px;

            border: 0;

            border-radius: 14px;

            background: #ff8a00;

            color: #07070a;

            font-weight: 900;

            font-size: 15px;

            letter-spacing: 0.05em;

            cursor: pointer;

            transition: transform 0.1s ease;

        }

        .copy-btn:hover { transform: translateY(-2px); }

        .copy-btn.copied { background: #1ed760; }

        .code-hint {

            margin-top: 18px;

            color: #777780;

            font-size: 14px;

            line-height: 1.6;

        }

        .stats {

            margin-top: 30px;

            display: grid;

            grid-template-columns: repeat(2, 1fr);

            gap: 15px;

        }

        .stat {

            padding: 25px;

            border: 1px solid #292930;

            border-radius: 20px;

            background: #0c0c10;

        }

        .stat strong {

            display: block;

            font-size: 42px;

            font-weight: 900;

            letter-spacing: -0.04em;

            color: #ff8a00;

        }

        .stat span {

            display: block;

            margin-top: 6px;

            color: #72727c;

            font-size: 12px;

            letter-spacing: 0.1em;

            font-weight: 700;

        }

        .section-title {

            margin: 55px 0 18px;

            font-size: 26px;

            font-weight: 900;

            letter-spacing: -0.04em;

        }

        .referral-list {

            border: 1px solid #292930;

            border-radius: 20px;

            overflow: hidden;

        }

        .referral-row {

            display: flex;

            align-items: center;

            justify-content: space-between;

            gap: 15px;

            padding: 18px 22px;

            border-bottom: 1px solid #1a1a1f;

        }

        .referral-row:last-child { border-bottom: 0; }

        .referral-user strong { display: block; font-size: 16px; font-weight: 800; }

        .referral-user span { color: #777780; font-size: 13px; }

        .referral-stats { text-align: right; }

        .referral-points {

            display: block;

            color: #1ed760;

            font-weight: 900;

            font-size: 15px;

        }

        .referral-date {

            display: block;

            color: #777780;

            font-size: 12px;

            margin-top: 2px;

        }

        .empty-state {

            margin-top: 30px;

            padding: 60px 30px;

            border: 1px solid #292930;

            border-radius: 25px;

            background: #0c0c10;

            text-align: center;

        }

        .empty-emoji { font-size: 72px; line-height: 1; }

        .empty-state h3 { margin: 20px 0 10px; font-size: 24px; font-weight: 900; }

        .empty-state p {

            max-width: 480px;

            margin: 0 auto;

            color: #a7a7b0;

            line-height: 1.6;

        }

        .footer {

            padding: 50px 6%;

            color: #606069;

            text-align: center;

            border-top: 1px solid #1f1f24;

            margin-top: 60px;

        }

        @media (max-width: 700px) {

            .stats { grid-template-columns: 1fr; }

        }

    </style>

</head>

<body>

    <nav class="nav">

        <a href="/" class="brand">
            CHUCKLEPAD
            <span>$CPAD</span>
        </a>

        <a href="/dashboard" class="back">
            ← Dashboard
        </a>

    </nav>

    <main class="container">

        <div class="eyebrow">
            INVITE &amp; EARN
        </div>

        <h1>
            Share the laugh.<br>
            Earn together.
        </h1>

        <p class="intro">
            Share your referral code with friends.
            When they register and use it, you earn
            <strong>1,000 Points</strong> — and so do they.
        </p>

        <section class="code-card">

            <div class="code-label">
                YOUR REFERRAL CODE
            </div>

            <div
                class="code-value"
                id="referralCode"
            >
                ${escapeHtml(profile?.referral_code || "————")}
            </div>

            <button
                class="copy-btn"
                id="copyBtn"
                type="button"
            >
                COPY CODE
            </button>

            <p class="code-hint">
                Share this code with friends.
                They enter it during registration.
            </p>

        </section>

        <section class="stats">

            <div class="stat">
                <strong>
                    ${escapeHtml(totalReferrals)}
                </strong>
                <span>PEOPLE REFERRED</span>
            </div>

            <div class="stat">
                <strong>
                    ${escapeHtml(totalReferralPoints.toLocaleString())}
                </strong>
                <span>POINTS EARNED</span>
            </div>

        </section>

        ${
            emptyState
                ? emptyState
                : `
                    <h2 class="section-title">
                        Your referrals
                    </h2>
                    <div class="referral-list">
                        ${referralListHtml}
                    </div>
                `
        }

    </main>

    <footer class="footer">

        ChucklePad —
        Laugh. Participate. Earn. Give Back.

    </footer>

    <script>

        const codeEl = document.getElementById("referralCode");
        const copyBtn = document.getElementById("copyBtn");

        if (codeEl && copyBtn) {

            copyBtn.addEventListener("click", async function () {

                const code = codeEl.textContent.trim();

                try {

                    await navigator.clipboard.writeText(code);

                    copyBtn.textContent = "COPIED 😂";
                    copyBtn.classList.add("copied");

                    setTimeout(() => {
                        copyBtn.textContent = "COPY CODE";
                        copyBtn.classList.remove("copied");
                    }, 2000);

                } catch (err) {

                    const range = document.createRange();
                    range.selectNode(codeEl);
                    window.getSelection().removeAllRanges();
                    window.getSelection().addRange(range);

                    try {
                        document.execCommand("copy");
                        copyBtn.textContent = "COPIED 😂";
                        copyBtn.classList.add("copied");
                        setTimeout(() => {
                            copyBtn.textContent = "COPY CODE";
                            copyBtn.classList.remove("copied");
                        }, 2000);
                    } catch (e) {
                        alert("Copy failed. Your code is: " + code);
                    }

                }

            });

        }

    </script>

</body>

</html>

        `);

    } catch (error) {

        console.error("Referrals page error:", error);
        res.status(500).send("Unable to load your referrals.");

    }

});


app.get("/api/referrals", requireAuth, async (req, res) => {

    try {

        const userId = req.session.user.id;

        const { data: referrals, error: referralsError } =
            await supabaseAdmin
                .from("referrals")
                .select(`
                    id,
                    referred_id,
                    referrer_reward,
                    created_at,
                    referred:profiles!referrals_referred_id_fkey (
                        username,
                        country,
                        points,
                        created_at
                    )
                `)
                .eq("referrer_id", userId)
                .order("created_at", { ascending: false });

        if (referralsError) throw referralsError;

        const { data: ledgerRows } =
            await supabaseAdmin
                .from("points_ledger")
                .select("amount")
                .eq("user_id", userId)
                .eq("reward_type", "referral");

        const totalPoints =
            (ledgerRows || []).reduce(
                (sum, row) => sum + Number(row.amount || 0),
                0
            );

        return res.json({
            success: true,
            total_referrals: (referrals || []).length,
            total_points: totalPoints,
            referrals: referrals || []
        });

    } catch (error) {

        console.error("Referrals API error:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to load referrals."
        });

    }

});


app.get("/heist", requireAuth, async (req, res) => {

    try {

        const userId = req.session.user.id;

        let heist = await getOrCreateCurrentHeist();

        heist = await settleHeistIfFinished(heist);

        const weekStart = `${heist.week_start}T00:00:00.000Z`;
        const weekEnd   = `${heist.week_end}T00:00:00.000Z`;

        const now = new Date();
        const weekEndDate = new Date(weekEnd);
        const finished = now >= weekEndDate;

        const { data: profile, error: profileError } =
            await supabaseAdmin
                .from("profiles")
                .select(`
                    username,
                    points,
                    tickets
                `)
                .eq("id", userId)
                .maybeSingle();

        if (profileError) throw profileError;

        const { data: weeklyHunts, error: weeklyHuntsError } =
            await supabaseAdmin
                .from("hunt_submissions")
                .select(`
                    tickets_awarded,
                    submitted_at
                `)
                .eq("user_id", userId)
                .eq("validation_status", "valid")
                .gt("tickets_awarded", 0)
                .gte("submitted_at", weekStart)
                .lt("submitted_at", weekEnd)
                .order("submitted_at", { ascending: true });

        if (weeklyHuntsError) throw weeklyHuntsError;

        const weeklyTickets =
            (weeklyHunts || []).reduce(
                (total, submission) =>
                    total + Number(submission.tickets_awarded || 0),
                0
            );

        const validHuntCount = (weeklyHunts || []).length;

        const { data: userResult, error: userResultError } =
            await supabaseAdmin
                .from("heist_results")
                .select(`
                    rank,
                    tickets,
                    points_awarded
                `)
                .eq("heist_id", heist.id)
                .eq("user_id", userId)
                .maybeSingle();

        if (userResultError) throw userResultError;

        let statusLabel = "OPEN";
        let statusClass = "open";

        if (heist.status === "completed") {

            statusLabel = "COMPLETED";
            statusClass = "completed";

        } else if (finished) {

            statusLabel = "WAITING FOR SETTLEMENT";
            statusClass = "waiting";

        }

        let resultHtml = "";

        if (userResult) {

            resultHtml = `

                <section class="result-card">

                    <div class="result-label">
                        YOUR HEIST RESULT
                    </div>

                    <div class="rank">

                        #${escapeHtml(userResult.rank)}

                    </div>

                    <div class="result-grid">

                        <div class="result-stat">

                            <strong>
                                ${escapeHtml(userResult.tickets)}
                            </strong>

                            <span>
                                Tickets
                            </span>

                        </div>

                        <div class="result-stat">

                            <strong>
                                ${escapeHtml(userResult.points_awarded)}
                            </strong>

                            <span>
                                Points Won
                            </span>

                        </div>

                    </div>

                </section>

            `;

        } else if (heist.status === "completed") {

            resultHtml = `

                <section class="result-card">

                    <div class="result-label">
                        HEIST COMPLETED
                    </div>

                    <p>
                        The Heist has been settled.
                        You did not finish inside the
                        winning 100 ranks this week.
                    </p>

                </section>

            `;

        } else if (finished) {

            resultHtml = `

                <section class="result-card">

                    <div class="result-label">
                        HEIST CLOSED
                    </div>

                    <p>
                        This week's Heist has ended.
                        Final rankings are being settled
                        by the ChucklePad server.
                    </p>

                </section>

            `;

        }

        const prizes = [
            { rank: "#1",       points: "100,000" },
            { rank: "#2",       points: "70,000"  },
            { rank: "#3",       points: "50,000"  },
            { rank: "#4–10",    points: "30,000 each" },
            { rank: "#11–25",   points: "15,000 each" },
            { rank: "#26–50",   points: "8,000 each"  },
            { rank: "#51–100",  points: "2,900 each"  }
        ];

        const prizeRows =
            prizes
                .map(
                    (prize) => `

                        <div class="prize-row">

                            <span>
                                ${escapeHtml(prize.rank)}
                            </span>

                            <strong>
                                ${escapeHtml(prize.points)}
                            </strong>

                        </div>

                    `
                )
                .join("");

        res.send(`

<!DOCTYPE html>

<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>
        ChucklePad — Weekly Heist
    </title>

    <style>

        * { box-sizing: border-box; }

        body {

            margin: 0;

            min-height: 100vh;

            background: #09090b;

            color: #f5f5f5;

            font-family: Arial, Helvetica, sans-serif;

        }

        a { color: inherit; text-decoration: none; }

        .nav {

            display: flex;

            align-items: center;

            justify-content: space-between;

            gap: 20px;

            padding: 20px 6%;

            border-bottom: 1px solid #252529;

        }

        .brand { font-weight: 900; letter-spacing: -0.04em; }

        .brand span { opacity: 0.5; margin-left: 6px; }

        .back { color: #a7a7b0; }

        .container {

            width: min(1000px, 92%);

            margin: 60px auto 90px;

        }

        .eyebrow {

            display: inline-block;

            padding: 8px 12px;

            border: 1px solid #3a3a42;

            border-radius: 999px;

            font-size: 11px;

            font-weight: 900;

            letter-spacing: 0.15em;

        }

        h1 {

            margin: 25px 0 15px;

            font-size: clamp(48px, 9vw, 100px);

            line-height: 0.9;

            letter-spacing: -0.075em;

        }

        .intro {

            max-width: 700px;

            color: #a7a7b0;

            font-size: 18px;

            line-height: 1.6;

        }

        .status {

            display: inline-flex;

            align-items: center;

            gap: 8px;

            margin-top: 20px;

            padding: 9px 14px;

            border: 1px solid #34343b;

            border-radius: 999px;

            font-size: 12px;

            font-weight: 900;

            letter-spacing: 0.08em;

        }

        .status-dot {

            width: 8px;

            height: 8px;

            border-radius: 50%;

            background: #ff8a00;

        }

        .pool-card {

            margin-top: 45px;

            padding: clamp(30px, 6vw, 65px);

            border: 1px solid #34343b;

            border-radius: 30px;

            background: #121216;

            box-shadow: 10px 10px 0 #030304;

        }

        .pool-label {

            color: #8b8b95;

            font-size: 12px;

            font-weight: 900;

            letter-spacing: 0.15em;

        }

        .pool {

            margin: 10px 0;

            font-size: clamp(55px, 11vw, 115px);

            font-weight: 900;

            line-height: 0.9;

            letter-spacing: -0.075em;

        }

        .pool span { color: #ff8a00; }

        .pool-note { color: #85858f; line-height: 1.5; }

        .week-card {

            margin-top: 25px;

            padding: 25px;

            border: 1px solid #292930;

            border-radius: 22px;

            background: #101014;

        }

        .week-title {

            margin-bottom: 18px;

            color: #85858f;

            font-size: 11px;

            font-weight: 900;

            letter-spacing: 0.13em;

        }

        .week-dates {

            display: grid;

            grid-template-columns: 1fr auto 1fr;

            align-items: center;

            gap: 20px;

        }

        .date-box strong { display: block; font-size: 20px; }

        .date-box span { color: #70707a; font-size: 12px; }

        .arrow { color: #ff8a00; font-weight: 900; }

        .countdown {

            margin-top: 20px;

            padding: 20px;

            border: 1px solid #292930;

            border-radius: 18px;

            text-align: center;

        }

        .countdown-label {

            color: #73737c;

            font-size: 11px;

            font-weight: 900;

            letter-spacing: 0.12em;

        }

        .countdown-time {

            margin-top: 8px;

            font-size: clamp(28px, 6vw, 50px);

            font-weight: 900;

            letter-spacing: -0.05em;

        }

        .stats {

            display: grid;

            grid-template-columns: repeat(3, 1fr);

            gap: 15px;

            margin-top: 25px;

        }

        .stat {

            padding: 25px;

            border: 1px solid #292930;

            border-radius: 20px;

            background: #101014;

        }

        .stat strong {

            display: block;

            font-size: 34px;

            letter-spacing: -0.04em;

        }

        .stat span {

            display: block;

            margin-top: 5px;

            color: #72727c;

            font-size: 12px;

        }

        .section { margin-top: 55px; }

        .section-title {

            margin-bottom: 18px;

            font-size: 28px;

            font-weight: 900;

            letter-spacing: -0.04em;

        }

        .prizes {

            overflow: hidden;

            border: 1px solid #292930;

            border-radius: 20px;

        }

        .prize-row {

            display: flex;

            align-items: center;

            justify-content: space-between;

            gap: 20px;

            padding: 19px 22px;

            border-bottom: 1px solid #24242a;

        }

        .prize-row:last-child { border-bottom: 0; }

        .prize-row span { color: #9999a3; }

        .prize-row strong { color: #ff8a00; }

        .steps {

            display: grid;

            grid-template-columns: repeat(3, 1fr);

            gap: 15px;

        }

        .step {

            padding: 25px;

            border: 1px solid #292930;

            border-radius: 20px;

            background: #101014;

        }

        .step-number {

            margin-bottom: 18px;

            color: #ff8a00;

            font-size: 12px;

            font-weight: 900;

        }

        .step h3 { margin: 0 0 10px; font-size: 19px; }

        .step p {

            margin: 0;

            color: #85858f;

            line-height: 1.55;

            font-size: 14px;

        }

        .result-card {

            margin-top: 25px;

            padding: 30px;

            border: 1px solid #34343b;

            border-radius: 25px;

            background: #121216;

        }

        .result-label {

            color: #ff8a00;

            font-size: 11px;

            font-weight: 900;

            letter-spacing: 0.14em;

        }

        .rank {

            margin: 12px 0 25px;

            font-size: 70px;

            font-weight: 900;

            line-height: 0.9;

            letter-spacing: -0.07em;

        }

        .result-card p { color: #9999a3; line-height: 1.6; }

        .result-grid {

            display: grid;

            grid-template-columns: repeat(2, 1fr);

            gap: 15px;

        }

        .result-stat {

            padding: 20px;

            border: 1px solid #292930;

            border-radius: 17px;

        }

        .result-stat strong { display: block; font-size: 30px; }

        .result-stat span { color: #73737c; font-size: 12px; }

        .footer {

            padding: 50px 6%;

            color: #606069;

            text-align: center;

            border-top: 1px solid #1f1f24;

        }

        @media (max-width: 700px) {

            .container { margin: 40px auto 70px; }

            .stats { grid-template-columns: 1fr; }

            .steps { grid-template-columns: 1fr; }

            .week-dates { grid-template-columns: 1fr; }

            .arrow { display: none; }

        }

        @media (max-width: 500px) {

            .result-grid { grid-template-columns: 1fr; }

        }

    </style>

</head>

<body>

    <nav class="nav">

        <a href="/" class="brand">
            CHUCKLEPAD
            <span>$CPAD</span>
        </a>

        <a href="/dashboard" class="back">
            ← Dashboard
        </a>

    </nav>

    <main class="container">

        <div class="eyebrow">
            WEEKLY COMMUNITY CHALLENGE
        </div>

        <h1>
            STEAL<br>
            THE PRIZE.
        </h1>

        <p class="intro">

            Turn your Daily Hunt tickets into
            your Weekly Heist score. The more
            valid tickets you earn during the
            week, the higher you can climb.

        </p>

        <div class="status">

            <span class="status-dot"></span>

            ${escapeHtml(statusLabel)}

        </div>

        <section class="pool-card">

            <div class="pool-label">
                WEEKLY PRIZE POOL
            </div>

            <div class="pool">
                1,000,000
                <span>PTS</span>
            </div>

            <div class="pool-note">

                100 winning ranks.
                Your Daily Hunt tickets determine
                your ranking.

            </div>

        </section>

        <section class="week-card">

            <div class="week-title">
                CURRENT HEIST WINDOW
            </div>

            <div class="week-dates">

                <div class="date-box">

                    <strong>
                        ${escapeHtml(heist.week_start)}
                    </strong>

                    <span>
                        MONDAY — START
                    </span>

                </div>

                <div class="arrow">
                    →
                </div>

                <div class="date-box">

                    <strong>
                        ${escapeHtml(heist.week_end)}
                    </strong>

                    <span>
                        MONDAY — END
                    </span>

                </div>

            </div>

            <div class="countdown">

                <div class="countdown-label">
                    TIME REMAINING
                </div>

                <div
                    class="countdown-time"
                    id="countdown"
                >
                    ${finished ? "HEIST ENDED" : "CALCULATING..."}
                </div>

            </div>

        </section>

        <section class="stats">

            <div class="stat">
                <strong>
                    ${escapeHtml(weeklyTickets)}
                </strong>
                <span>
                    YOUR WEEKLY TICKETS
                </span>
            </div>

            <div class="stat">
                <strong>
                    ${escapeHtml(validHuntCount)}
                </strong>
                <span>
                    VALID HUNTS
                </span>
            </div>

            <div class="stat">
                <strong>
                    ${escapeHtml(Number(profile?.points || 0))}
                </strong>
                <span>
                    TOTAL POINTS
                </span>
            </div>

        </section>

        ${resultHtml}

        <section class="section">

            <div class="section-title">
                PRIZE DISTRIBUTION
            </div>

            <div class="prizes">

                ${prizeRows}

            </div>

        </section>

        <section class="section">

            <div class="section-title">
                HOW THE HEIST WORKS
            </div>

            <div class="steps">

                <div class="step">

                    <div class="step-number">
                        STEP 01
                    </div>

                    <h3>
                        Complete Hunts
                    </h3>

                    <p>
                        Participate in Daily Hunts
                        throughout the week and
                        earn tickets from valid
                        submissions.
                    </p>

                </div>

                <div class="step">

                    <div class="step-number">
                        STEP 02
                    </div>

                    <h3>
                        Build Your Score
                    </h3>

                    <p>
                        Your valid tickets are
                        accumulated during the
                        Monday-to-Monday Heist
                        window.
                    </p>

                </div>

                <div class="step">

                    <div class="step-number">
                        STEP 03
                    </div>

                    <h3>
                        Climb the Ranks
                    </h3>

                    <p>
                        At the end of the week,
                        ChucklePad's server ranks
                        eligible participants and
                        distributes the prize pool.
                    </p>

                </div>

            </div>

        </section>

        <section class="section">

            <div class="section-title">
                THE RULE
            </div>

            <div class="result-card">

                <div class="result-label">
                    SERVER-AUTHORITATIVE
                </div>

                <p>

                    The browser cannot create,
                    modify, or choose Weekly Heist
                    winners. Final rankings and
                    rewards are determined by the
                    ChucklePad PostgreSQL settlement
                    function using valid Daily Hunt
                    submissions.

                </p>

            </div>

        </section>

    </main>

    <footer class="footer">

        ChucklePad —
        Laugh. Participate. Earn. Give Back.

    </footer>

    <script>

        const countdownElement = document.getElementById("countdown");

        const target =
            new Date("${escapeHtml(weekEnd)}").getTime();

        function updateCountdown() {

            const now = Date.now();
            const difference = target - now;

            if (difference <= 0) {

                countdownElement.textContent = "HEIST ENDED";
                return;

            }

            const totalSeconds = Math.floor(difference / 1000);

            const days    = Math.floor(totalSeconds / 86400);
            const hours   = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;

            countdownElement.textContent =

                days + "d " +
                String(hours).padStart(2, "0") + "h " +
                String(minutes).padStart(2, "0") + "m " +
                String(seconds).padStart(2, "0") + "s";

        }

        updateCountdown();
        setInterval(updateCountdown, 1000);

    </script>

</body>

</html>

        `);

    } catch (error) {

        console.error("Weekly Heist page error:", error);
        res.status(500).send("Unable to load the Weekly Heist.");

    }

});


app.get("/api/heist/status", requireAuth, async (req, res) => {

    try {

        let heist = await getOrCreateCurrentHeist();

        heist = await settleHeistIfFinished(heist);

        const { data: participant, error: participantError } =
            await supabaseAdmin
                .from("heist_results")
                .select(`
                    rank,
                    tickets,
                    points_awarded
                `)
                .eq("heist_id", heist.id)
                .eq("user_id", req.session.user.id)
                .maybeSingle();

        if (participantError) throw participantError;

        const weekEnd = new Date(`${heist.week_end}T00:00:00.000Z`);
        const now = new Date();
        const finished = now >= weekEnd;

        const { data: weeklyHunts, error: weeklyHuntsError } =
            await supabaseAdmin
                .from("hunt_submissions")
                .select("tickets_awarded")
                .eq("user_id", req.session.user.id)
                .eq("validation_status", "valid")
                .gt("tickets_awarded", 0)
                .gte("submitted_at", `${heist.week_start}T00:00:00.000Z`)
                .lt("submitted_at", `${heist.week_end}T00:00:00.000Z`);

        if (weeklyHuntsError) throw weeklyHuntsError;

        const weeklyTickets =
            (weeklyHunts || []).reduce(
                (total, hunt) =>
                    total + Number(hunt.tickets_awarded || 0),
                0
            );

        return res.json({
            success: true,
            heist: {
                id: heist.id,
                week_start: heist.week_start,
                week_end: heist.week_end,
                prize_pool: Number(heist.prize_pool),
                status: heist.status,
                finished
            },
            user: {
                weekly_tickets: weeklyTickets,
                valid_hunts: (weeklyHunts || []).length
            },
            result: participant || null
        });

    } catch (error) {

        console.error("Weekly Heist status error:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to load Weekly Heist status."
        });

    }

});


app.get("/api/heist/results", requireAuth, async (req, res) => {

    try {

        let heist = await getOrCreateCurrentHeist();

        heist = await settleHeistIfFinished(heist);

        const { data: results, error } =
            await supabaseAdmin
                .from("heist_results")
                .select(`
                    rank,
                    user_id,
                    tickets,
                    points_awarded
                `)
                .eq("heist_id", heist.id)
                .order("rank", { ascending: true })
                .limit(100);

        if (error) throw error;

        return res.json({
            success: true,
            heist_id: heist.id,
            status: heist.status,
            results: results || []
        });

    } catch (error) {

        console.error("Weekly Heist results error:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to load Weekly Heist results."
        });

    }

});


app.get("/airdrop", (req, res) => {

    res.render("airdrop", {
        title: "CPAD Airdrop"
    });

});


app.get("/ecosystem", (req, res) => {

    res.render("ecosystem", {
        title: "Ecosystem"
    });

});


app.get("/roadmap", (req, res) => {

    res.render("roadmap", {
        title: "Roadmap"
    });

});


app.get("/disclaimer", (req, res) => {

    res.render("disclaimer", {
        title: "Disclaimer"
    });

});


app.get("/terms", (req, res) => {

    res.render("terms", {
        title: "Terms of Service"
    });

});


app.use((req, res) => {

    res.status(404).send("Page not found.");

});


app.use((error, req, res, next) => {

    console.error("EXPRESS ERROR:", error);
    res.status(500).send("Internal server error.");

});


app.listen(PORT, () => {

    console.log("");

    console.log(
        "======================================"
    );

    console.log(
        "             CHUCKLEPAD"
    );

    console.log(
        "======================================"
    );

    console.log(
        "Laugh. Participate. Earn. Give Back."
    );

    console.log("");

    console.log(`http://localhost:${PORT}`);
    console.log(`Gemini model: ${GEMINI_MODEL}`);

    console.log(
        "======================================"
    );

    console.log("");

});