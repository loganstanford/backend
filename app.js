const express = require("express");
const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();
const BASE_URL = "https://insider.sternpinball.com/kiosk/";
app.use(cors());

const fs = require("fs").promises; // Use the promises version for async/await

// Create a MySQL connection using mysql2
const connection = mysql.createPool({
  host: "localhost", // Host where the MySQL server is running
  user: "logan", // Your MySQL user
  password: "logan_ology_2023!", // Your MySQL password
  database: "pinball", // The name of the database you want to connect to
});

const fetchRenderedHTML = async (url) => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle0" });
  const html = await page.content();
  await browser.close();
  return html;
};

const parseHtmlContent = (html) => {
  const $ = cheerio.load(html);
  const games = {};

  $(".list-item.card.list").each((i, elem) => {
    const gameName = $(elem)
      .find(".leaderboard-header p.hd-xs")
      .text()
      .replace("High Scores", "")
      .trim();
    const headerImgUrl = $(elem).find(".leaderboard-header img").attr("src"); // Extract the header image URL
    const game = gameName || "Unknown";
    games[game] = {
      scores: [],
      headerUrl: headerImgUrl || "Unknown", // Store the header image URL
    };

    $(elem)
      .find("li")
      .each((j, scoreElem) => {
        const username = $(scoreElem).find("p.font-semibold").text().trim();
        const scoreText = $(scoreElem).find("div.text-vintage").text().trim();
        const iconUrl = $(scoreElem).find(".bg-profile img").attr("src");
        const colorStyle = $(scoreElem)
          .find(".flex.justify-end.items-center")
          .attr("style");
        const colorMatch = /--profile-color: (#[0-9a-fA-F]+)/.exec(colorStyle);
        const colorRgb = colorMatch ? colorMatch[1] : null;
        const score = scoreText.replace(/,/g, ""); // Removing commas for numeric value

        if (username && score) {
          games[game].scores.push({
            username,
            score,
            iconUrl, // Adding icon URL
            colorRgb, // Adding RGB color
          });
        }
      });
  });

  return games;
};

const getOrInsertGame = async (gameName, headerUrl) => {
  const gameQuery = "SELECT id, headerUrl FROM games WHERE name = ?";
  const insertGameQuery =
    "INSERT INTO games (name, headerUrl, datecreated) VALUES (?, ?, NOW())";
  const updateGameQuery = "UPDATE games SET headerUrl = ? WHERE id = ?";

  const [gameRows] = await connection.query(gameQuery, [gameName]);
  let gameId;

  if (gameRows.length > 0) {
    gameId = gameRows[0].id;
    // Check if the headerUrl has changed
    if (gameRows[0].headerUrl !== headerUrl) {
      // Update game record with new headerUrl
      await connection.query(updateGameQuery, [headerUrl, gameId]);
    }
  } else {
    const [insertResult] = await connection.query(insertGameQuery, [
      gameName,
      headerUrl,
    ]);
    gameId = insertResult.insertId;
  }

  return gameId;
};

const getOrInsertUser = async (username, iconUrl, colorRgb) => {
  let userId;
  const userQuery =
    "SELECT id, iconUrl, colorRgb FROM users WHERE username = ?";
  const insertUserQuery =
    "INSERT INTO users (username, iconUrl, colorRgb, datecreated) VALUES (?, ?, ?, NOW())";
  const updateUserQuery =
    "UPDATE users SET iconUrl = ?, colorRgb = ? WHERE id = ?";

  // Check if the user already exists in the database
  const [userRows] = await connection.query(userQuery, [username]);
  if (userRows.length > 0) {
    // User exists, get their ID
    userId = userRows[0].id;

    // Check if the icon URL or color RGB value has changed
    if (userRows[0].iconUrl !== iconUrl || userRows[0].colorRgb !== colorRgb) {
      // Update user record with new icon URL and color RGB value
      await connection.query(updateUserQuery, [iconUrl, colorRgb, userId]);
    }
  } else {
    // Insert new user record into the database
    const [insertResult] = await connection.query(insertUserQuery, [
      username,
      iconUrl,
      colorRgb,
    ]);
    userId = insertResult.insertId;
  }

  return userId;
};

const insertScore = async (userId, gameId, score) => {
  const scoreNumeric = parseInt(score.replace(/,/g, ""), 10); // Remove commas and convert to integer

  // Check if the score already exists
  const checkScoreQuery = `
      SELECT 1 FROM scores 
      WHERE userId = ? AND gameId = ? AND score = ?
    `;
  const [existingScores] = await connection.query(checkScoreQuery, [
    userId,
    gameId,
    scoreNumeric,
  ]);

  // If the score does not exist, insert it
  if (existingScores.length === 0) {
    const insertScoreQuery = `
        INSERT INTO scores (userId, gameId, score, dateAdded) 
        VALUES (?, ?, ?, NOW())
      `;
    await connection.query(insertScoreQuery, [userId, gameId, scoreNumeric]);
  }
};

app.get("/api/scores/:path", async (req, res) => {
  let games; // Declare games outside the try block for access in the catch block
  try {
    const pathParam = req.params.path;
    const fullUrl = BASE_URL + pathParam;
    const html = await fetchRenderedHTML(fullUrl);
    games = parseHtmlContent(html); // This variable is used in the catch block, so it's declared outside

    for (const [gameName, gameData] of Object.entries(games)) {
      const gameId = await getOrInsertGame(gameName, gameData.headerUrl);

      for (const scoreEntry of gameData.scores) {
        const userId = await getOrInsertUser(
          scoreEntry.username,
          scoreEntry.iconUrl,
          scoreEntry.colorRgb
        );
        await insertScore(userId, gameId, scoreEntry.score);
      }
    }

    res.json({
      message: "Scores have been processed and saved to the database",
    });
  } catch (error) {
    console.error("Error:", error);

    // Construct a file name with a timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `failed-scores-${timestamp}.json`;

    try {
      if (games) {
        // Check if 'games' is not undefined before trying to write
        await fs.writeFile(filename, JSON.stringify(games, null, 2));
        console.log(`Saved games to ${filename} due to an error.`);
      }
    } catch (fsError) {
      console.error("Failed to save games to a file:", fsError);
    }

    res.status(500).send("Failed to process and save scores");
  }
});

app.get("/api/scores", async (req, res) => {
  try {
    const query = `
      SELECT
        g.name AS gameName,
        g.headerUrl,
        u.id AS userId,
        u.username AS userName,
        u.iconUrl,
        u.colorRgb,
        s.score,
        s.dateAdded AS scoreDate
      FROM scores s
      JOIN users u ON s.userId = u.id
      JOIN games g ON s.gameId = g.id
      ORDER BY g.name, s.score DESC;
    `;

    const [results] = await connection.query(query);

    // Transform the flat results into the nested structure
    const games = results.reduce((acc, curr) => {
      // Find or create the game entry in the accumulator
      let gameEntry = acc.find((entry) => entry.gameName === curr.gameName);
      if (!gameEntry) {
        gameEntry = {
          gameName: curr.gameName,
          headerUrl: curr.headerUrl,
          scores: [],
        };
        acc.push(gameEntry);
      }
      // Add the current score to the game entry
      gameEntry.scores.push({
        userId: curr.userId,
        userName: curr.userName,
        iconUrl: curr.iconUrl,
        colorRgb: curr.colorRgb,
        score: curr.score,
        scoreDate: curr.scoreDate,
      });
      return acc;
    }, []);

    res.json(games);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("Failed to retrieve scores from the database");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
