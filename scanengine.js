// scanEngine.js
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Keywords that flag grinding-related work
const GRINDING_KEYWORDS = [
  'diamond grinding',
  'diamond-grinding',
  'grinding',
  'bump grinding',
  'profile grinding',
  'ngcs',
  'next generation concrete surface',
  'grooving',
  'saw cut grooving',
  'surface texturing',
  'pavement grinding'
];

function hasGrinding(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return GRINDING_KEYWORDS.some(k => lower.includes(k));
}

function findMatchedKeywords(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return GRINDING_KEYWORDS.filter(k => lower.includes(k));
}

// Build a stable UID so we don’t duplicate projects
function buildProjectUid({ state, lettingDate, title, county }) {
  return [
    state || 'TX',
    lettingDate || '',
    (county || '').toLowerCase().replace(/\s+/g, '-'),
    (title || '').toLowerCase().replace(/\s+/g, '-')
  ].join('|');
}

async function fetchTxdotStatewideLettings() {
  const url = 'https://www.txdot.gov/business/letting-bids.html';
  console.log(`Fetching TxDOT statewide lettings from ${url}`);
  const res = await axios.get(url);
  const $ = cheerio.load(res.data);

  const projects = [];

  // This assumes a classic HTML table with <tbody><tr> rows
  $('table tbody tr').each((_, row) => {
    const tds = $(row).find('td');
    if (tds.length === 0) return;

    const lettingDate = $(tds[0]).text().trim() || null;
    const district = $(tds[1]).text().trim() || null;
    const county = $(tds[2]).text().trim() || null;
    const description = $(tds[3]).text().trim() || null;

    const title = description || `TxDOT Letting - ${district || ''} ${county || ''}`.trim();

    const project = {
      state: 'TX',
      agency: 'TxDOT',
      title,
      description,
      lettingDate,
      district,
      county
    };

    projects.push(project);
  });

  console.log(`Parsed ${projects.length} rows from TxDOT statewide lettings`);
  return projects;
}

async function upsertProject(client, project) {
  const { state, agency, title, description, lettingDate, county } = project;
  const projectUid = buildProjectUid({ state, lettingDate, title, county });
  const grindingFlag = hasGrinding(description || title);
  const matchedKeywords = findMatchedKeywords((description || '') + ' ' + (title || ''));

  // Insert or update project
  const result = await client.query(
    `
    INSERT INTO projects (
      project_uid,
      agency,
      state,
      title,
      description,
      status,
      letting_date,
      grinding_flag
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (project_uid)
    DO UPDATE SET
      agency = EXCLUDED.agency,
      state = EXCLUDED.state,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      letting_date = EXCLUDED.letting_date,
      grinding_flag = EXCLUDED.grinding_flag,
      updated_at = NOW()
    RETURNING id, grinding_flag;
    `,
    [
      projectUid,
      agency,
      state,
      title,
      description,
      'open',
      lettingDate ? new Date(lettingDate) : null,
      grindingFlag
    ]
  );

  const row = result.rows[0];

  // If grinding is detected, record why in grinding_items
  if (row && grindingFlag && matchedKeywords.length > 0) {
    for (const keyword of matchedKeywords) {
      await client.query(
        `
        INSERT INTO grinding_items (project_id, keyword, notes)
        VALUES ($1,$2,$3)
        `,
        [row.id, keyword, 'Detected from TxDOT statewide letting description/title']
      );
    }
  }

  return { isGrinding: grindingFlag };
}

async function runTxdotScan() {
  const client = await pool.connect();
  const start = new Date();
  let newCount = 0;
  let updatedCount = 0;

  try {
    const projects = await fetchTxdotStatewideLettings();

    for (const p of projects) {
      const result = await upsertProject(client, p);
      if (result.isGrinding) {
        console.log(`Grinding project detected: ${p.title}`);
      }
      // We’re not distinguishing new vs updated here yet; you can refine later
      newCount++;
    }

    await client.query(
      `
      INSERT INTO scan_log (scan_time, new_projects, updated_projects, errors)
      VALUES ($1,$2,$3,$4)
      `,
      [start, newCount, updatedCount, null]
    );

    console.log(`TxDOT scan complete. Projects processed: ${newCount}`);
  } catch (err) {
    console.error('Error during TxDOT scan:', err.message);
    await client.query(
      `
      INSERT INTO scan_log (scan_time, new_projects, updated_projects, errors)
      VALUES ($1,$2,$3,$4)
      `,
      [start, newCount, updatedCount, err.message]
    );
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runTxdotScan
};
