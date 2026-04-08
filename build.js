#!/usr/bin/env node
/**
 * build.js — Arizona EDM Calendar
 * Runs weekly via GitHub Actions.
 * 1. Fetches electronic events from Ticketmaster API for Phoenix + Tucson
 * 2. Merges with curated events (festivals, Walter WhereHouse, etc.)
 * 3. Injects everything into index.html → dist/index.html
 *
 * Required env vars:
 *   TM_API_KEY  — your Ticketmaster API key (free at developer.ticketmaster.com)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const TM_KEY = process.env.TM_API_KEY;
if (!TM_KEY) { console.error('ERROR: TM_API_KEY env var not set'); process.exit(1); }

// ─── helpers ───────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse failed: ' + data.slice(0,200))); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Ticketmaster city codes + radius
const MARKETS = [
  { id: 'phoenix',  dma: 'Phoenix',  stateCode: 'AZ', city: 'Phoenix'  },
  { id: 'tucson',   dma: 'Tucson',   stateCode: 'AZ', city: 'Tucson'   },
];

const EDM_KEYWORDS = ['edm','electronic','rave','techno','house','dubstep','bass','festival','dnb','drum and bass','trance','club','dj'];

// Venues to exclude from TM results (not relevant to AZ EDM competitive landscape)
const EXCLUDED_VENUES = ['valley bar', 'crescent ballroom', 'celebrity theatre', 'talking stick resort arena', 'footprint center', 'ak-chin pavilion'];

function isEDM(event) {
  const name = (event.name || '').toLowerCase();
  const genre = ((event.classifications?.[0]?.genre?.name) || '').toLowerCase();
  const subgenre = ((event.classifications?.[0]?.subGenre?.name) || '').toLowerCase();
  const segment = ((event.classifications?.[0]?.segment?.name) || '').toLowerCase();
  const venueName = (event._embedded?.venues?.[0]?.name || '').toLowerCase();
  // Exclude non-EDM venues
  if (EXCLUDED_VENUES.some(v => venueName.includes(v))) return false;
  const combined = [name, genre, subgenre, segment].join(' ');
  // Must be Music segment
  if (segment && segment !== 'music') return false;
  return EDM_KEYWORDS.some(k => combined.includes(k));
}

function guessMarket(event) {
  const venue = event._embedded?.venues?.[0];
  const city = (venue?.city?.name || '').toLowerCase();
  const state = (venue?.state?.stateCode || '').toLowerCase();
  if (state !== 'az') return null;
  if (city.includes('tucson')) return 'tucson';
  // everything else in AZ (phoenix, scottsdale, tempe, chandler, mesa, glendale, avondale) → phoenix market
  return 'phoenix';
}

function formatPrice(event) {
  if (!event.priceRanges?.length) return 'See tickets';
  const r = event.priceRanges[0];
  if (r.min && r.max && r.min !== r.max) return `$${Math.round(r.min)}–$${Math.round(r.max)}`;
  if (r.min) return `$${Math.round(r.min)}+`;
  return 'See tickets';
}

function tmToEvent(event, market) {
  const venue = event._embedded?.venues?.[0];
  const dateStr = event.dates?.start?.localDate || '';
  const venueName = venue?.name || 'TBA';
  const cityName = venue?.city?.name || '';
  return {
    artist: event.name,
    venue: venueName,
    city: cityName,
    market,
    date: dateStr,
    price: formatPrice(event),
    promoter: event.promoter?.name || event.promotions?.[0]?.name || '',
    genre: event.classifications?.[0]?.subGenre?.name || event.classifications?.[0]?.genre?.name || 'Electronic',
    url: event.url || '',
    source: 'ticketmaster',
    fest: (event.classifications?.[0]?.subGenre?.name || '').toLowerCase().includes('festival'),
    lineup: [],
  };
}

async function fetchTM(city, stateCode) {
  const today = new Date().toISOString().split('T')[0];
  // go back 60 days for past shows, forward 365 days
  const pastDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  let all = [];
  let page = 0;
  while (true) {
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?` +
      `apikey=${TM_KEY}` +
      `&city=${encodeURIComponent(city)}` +
      `&stateCode=${stateCode}` +
      `&countryCode=US` +
      `&classificationName=music` +
      `&size=200` +
      `&page=${page}` +
      `&startDateTime=${pastDate}T00:00:00Z` +
      `&endDateTime=${futureDate}T23:59:59Z` +
      `&sort=date,asc`;

    console.log(`  Fetching TM: ${city} page ${page}...`);
    const data = await get(url);

    if (data.fault) { console.warn('  TM API fault:', data.fault.faultstring); break; }

    const events = data._embedded?.events || [];
    if (events.length === 0) break;
    all = all.concat(events);

    const total = data.page?.totalPages || 1;
    if (page >= total - 1 || page >= 4) break; // max 5 pages per city
    page++;
    await sleep(300); // respect rate limit
  }
  return all;
}

// ─── CURATED EVENTS (festivals + Walter WhereHouse + key shows) ─────────────
// These supplement the Ticketmaster feed with verified lineup data
const CURATED = [
  // M3F (McDowell Mountain Music Festival) 2024
  { artist:"M3F Festival 2024 — Day 1", venue:"Steele Indian School Park", city:"Phoenix", market:"phoenix", date:"2024-03-01", price:"$85–$185", promoter:"M3F Fest (nonprofit)", genre:"Festival (Electronic/Indie)", url:"https://www.m3ffest.com", fest:true, source:"curated",
    lineup:[{ day:"Fri Mar 1", artists:"Dominic Fike, Lane 8, Gorgon City, SG Lewis, Duke Dumont, Elderbrook, GORDO, Poolside, WhoMadeWho, it's murph, Coco & Breezy, DRAMA, bunt., Edapollo, Young Franco, Dayglow, Bakar, Arlo Parks, Roosevelt, Vandelux, Fiji Blue, LEISURE, Tim Atlas, Jules Duke, Coast, Shifty, Barrett Bennett, KOL, Tommy Newport, Hippo Campus" }]},
  { artist:"M3F Festival 2024 — Day 2", venue:"Steele Indian School Park", city:"Phoenix", market:"phoenix", date:"2024-03-02", price:"$85–$185", promoter:"M3F Fest (nonprofit)", genre:"Festival (Electronic/Indie)", url:"https://www.m3ffest.com", fest:true, source:"curated" },
  // M3F 2025
  { artist:"M3F Festival 2025 — Day 1", venue:"Steele Indian School Park", city:"Phoenix", market:"phoenix", date:"2025-03-07", price:"$110–$185", promoter:"M3F Fest (nonprofit)", genre:"Festival (Electronic/Indie)", url:"https://www.m3ffest.com", fest:true, source:"curated",
    lineup:[{ day:"Fri Mar 7", artists:"LCD Soundsystem (headliner), Alvvays, alice.km, BADBADNOTGOOD, Braxe + Falcon, Dev Lemons, Hippie Sabotage, late night drive home, LP Giobbi, Orions Belte, Pariah Pete, Ricky Montgomery, Slow Pulp, Summer Salt, TEED" }]},
  { artist:"M3F Festival 2025 — Day 2", venue:"Steele Indian School Park", city:"Phoenix", market:"phoenix", date:"2025-03-08", price:"$110–$185", promoter:"M3F Fest (nonprofit)", genre:"Festival (Electronic/Indie)", url:"https://www.m3ffest.com", fest:true, source:"curated",
    lineup:[{ day:"Sat Mar 8", artists:"Justice (headliner), Sylvan Esso, ALEXSUCKS, BAYNK, Beach Weather, Chloe Tang, Confidence Man, Doss, Eggy, Frost Children, Girl Talk, Goldwax Revival, LEISURE, Luna Luna, Mindchatter, Monster Rally, The Strike, Upsahl" }]},
  // M3F 2026
  { artist:"M3F Festival 2026 — Day 1", venue:"Steele Indian School Park", city:"Phoenix", market:"phoenix", date:"2026-03-06", price:"$110–$185", promoter:"M3F Fest (nonprofit)", genre:"Festival (Electronic/Indie)", url:"https://www.m3ffest.com", fest:true, source:"curated",
    lineup:[{ day:"Fri Mar 6 — Vista / Cosmic / Day Dream stages", artists:"Peggy Gou (headliner), Big Wild, Chris Lorenzo, La Roux, TOKiMONSTA, Mild Minds, Neil Frances, RaeCola, jigitz, Rio Kosta, Artemas, Cuco, Magdalena Bay, Thxbby, The Kaleidoscope Kid, Peachy Keen" }]},
  { artist:"M3F Festival 2026 — Day 2", venue:"Steele Indian School Park", city:"Phoenix", market:"phoenix", date:"2026-03-07", price:"$110–$185", promoter:"M3F Fest (nonprofit)", genre:"Festival (Electronic/Indie)", url:"https://www.m3ffest.com", fest:true, source:"curated",
    lineup:[{ day:"Sat Mar 7 — Vista / Cosmic / Day Dream stages", artists:"Mau P (headliner), Polo & Pan, Elderbrook, Dora Jar, The Knocks, Nimino, 2hollis, salute, Avery Cochrane, Loukeman, Of The Trees, Daily Bread, After, Bricknasty, SEES00000, Kol, Country Night, Barrett, Hostel, Tommy Toole" }]},
  // PHXLIGHTS Supernova 2024
  { artist:"PHXLIGHTS: Supernova 2024", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2024-03-29", price:"$60–$150", promoter:"Relentless Beats", genre:"Festival (EDM)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[
      { day:"Mar 29", artists:"Seven Lions, NGHTMRE, Joyryde b2b Habstrakt, ALOK, Goddard, SABAI" },
      { day:"Mar 30", artists:"Kaskade, Deorro b2b Valentino Khan, Dr. Oliver Tree, Apashe, Levity" }
    ]},
  // Basstrack 2024
  { artist:"Basstrack 2024 — Night 1", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2024-09-27", price:"$60–$130", promoter:"Relentless Beats / Aftershock", genre:"Festival (Bass)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Sep 27", artists:"Excision, Wooli, Space Laces, PhaseOne b2b Kompany, Eliminate, YOOKiE, Layz, Emorfik b2b Muerte, Drinkurwater b2b Cyclops, Stellar, Kliptic b2b RZRKT" }]},
  { artist:"Basstrack 2024 — Night 2", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2024-09-28", price:"$60–$130", promoter:"Relentless Beats / Aftershock", genre:"Festival (Bass)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Sep 28", artists:"Excision, Wooli, Space Laces, PhaseOne b2b Kompany, Eliminate, YOOKiE + more" }]},
  // Goldrush Wild Card 2024
  { artist:"Goldrush: Wild Card 2024 — Night 1", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2024-10-04", price:"$99–$250+", promoter:"Relentless Beats / Universatile / Global Dance", genre:"Festival (Multi-genre)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Oct 4 (Fri)", artists:"Alesso, The Chainsmokers, Ganja White Night, &Friends, Alix Perez, Anatta, Andruss, Blossom, DJ Pauly D, Halogenix, Monty b2b Two Swords (fka Hyroglifics), Nikademis, Ray Volpe, San Pacho, Shermanology, Sound Rush, Sullivan King, Timmy Trumpet, Walker & Royce, Guestli$t b2b Chiief, Nealson" }]},
  { artist:"Goldrush: Wild Card 2024 — Night 2", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2024-10-05", price:"$99–$250+", promoter:"Relentless Beats / Universatile / Global Dance", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Oct 5 (Sat)", artists:"Slander, Black Tiger Sex Machine (The Anime Show), AC Slater, Acraze b2b Noizu, Audien, Deathpact, Heyz, Hvdes, Inzo b2b Mersiv, Jackie Hollander, Mall Grab, Matt Sassari, MitiS, OG Nixin, Omnom, Pola & Bryson, San Holo (DJ Set), Sanzu, YDG, Arietta, Hotsauce" }]},
  // Body Language Super Unnatural 2024
  { artist:"Body Language: Super Unnatural", venue:"WestWorld of Scottsdale", city:"Scottsdale", market:"phoenix", date:"2024-11-01", price:"$45–$90", promoter:"Relentless Beats / Body Language", genre:"House/Techno", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Nov 1–2", artists:"Nicole Moudaber, Klangkuenstler + house & techno artists" }]},
  // DUSK 2024
  { artist:"DUSK Music Festival 2024 — Night 1", venue:"Jácome Plaza", city:"Tucson", market:"tucson", date:"2024-11-09", price:"$35–$75", promoter:"Relentless Beats / Rio Nuevo", genre:"Festival (Multi-genre)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Nov 9–10", artists:"Multi-genre electronic & indie lineup — Relentless Beats + Rio Nuevo curated" }]},
  // Decadence AZ 2024
  { artist:"Decadence Arizona 2024 — Night 1", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2024-12-30", price:"$80–$250+", promoter:"Relentless Beats / Global Dance", genre:"Festival (Multi-genre)", url:"https://decadencearizona.com", fest:true, source:"curated",
    lineup:[{ day:"Dec 30", artists:"deadmau5, Dom Dolla, Eli & Fur, Eptic b2b Space Laces, Excision, JSTJR b2b Nostalgix, Le Youth, Svdden Death, Tchami x Malaa: No Redemption, Troyboi, Wooli, 2SOON, Slippe" }]},
  { artist:"Decadence Arizona 2024 — Night 2 (NYE)", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2024-12-31", price:"$80–$250+", promoter:"Relentless Beats / Global Dance", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Dec 31", artists:"John Summit (NYE Countdown), ARMNHMR, Deorro, Dog Eat Dog (Crankdat b2b Riot Ten), Dr. Fresch b2b BIJOU, Eater b2b STVSH, Gudfella, ISOxo, Mau P, Sidepiece, Valentino Khan, Zeds Dead, Justin Irby, Raven & Ali" }]},
  // Body Language Fest 2025 (rescheduled from Feb 2024 cancellation)
  { artist:"Body Language Fest 2025 — Night 1", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-02-16", price:"$65–$150", promoter:"Relentless Beats / RBDeep", genre:"Festival (House/Techno)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Feb 16 — State of Mind stage + Main", artists:"Eric Prydz (headliner), Sofi Tukker (DJ set), Meduza, Charles D, Hugel, Kream, Layton Giordani, Martin Ikin, Never Dull, Omnon, Sammy Virji, Shermanology" }]},
  { artist:"Body Language Fest 2025 — Night 2 (Drumcode)", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-02-17", price:"$65–$150", promoter:"Relentless Beats / RBDeep", genre:"Festival (House/Techno)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Feb 17 — Drumcode Records takeover + Main", artists:"deadmau5 (headliner), Dubfire; Drumcode Stage: Charles D, Chris Avantgarde, Layton Giordani, Marco Faraone, Melania Ribbe, Natalia Roth, Disco Zombie" }]},
  // Gem & Jam 2025
  { artist:"Gem & Jam Festival 2025", venue:"Rillito Regional Park", city:"Tucson", market:"tucson", date:"2025-02-06", price:"$120–$300+", promoter:"Gem & Jam", genre:"Festival (Jam/Electronic)", url:"https://gemandjam.com", fest:true, source:"curated",
    lineup:[{ day:"Feb 6–9", artists:"The Polish Ambassador, Desert Dwellers, Mr. Bill, Moontricks, lespecial + 50 more artists" }]},
  // SLANDER at Rawhide (standalone show)
  { artist:"SLANDER", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2025-02-01", price:"$35–$75", promoter:"Relentless Beats", genre:"Melodic Bass", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Feb 1", artists:"SLANDER" }]},
  // Breakaway Arizona 2025 (debut edition)
  { artist:"Breakaway Arizona 2025 — Day 1", venue:"Sloan Park Festival Grounds", city:"Mesa", market:"phoenix", date:"2025-04-18", price:"$30–$200+", promoter:"Breakaway × Relentless Beats", genre:"Festival (Multi-genre)", url:"https://www.breakawayfestival.com/festival/arizona-2025", fest:true, source:"curated",
    lineup:[{ day:"Apr 18 (Fri)", artists:"The Chainsmokers, Gryffin, Two Friends, Audien, Wax Motif, PEEKABOO, Moore Kismet, Coco & Breezy, Zerb, Levity, Daniel Allen, Frank Walker, Koastle, Night Tales, Sidequest, Skilah, Tommy Toole" }]},
  { artist:"Breakaway Arizona 2025 — Day 2", venue:"Sloan Park Festival Grounds", city:"Mesa", market:"phoenix", date:"2025-04-19", price:"$30–$200+", promoter:"Breakaway × Relentless Beats", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Sat Apr 19", artists:"Gryffin (headliner), Sofi Tukker (DJ Set), Two Friends, PEEKABOO, Moore Kismet, Coco & Breezy, Cyclops, Juelz, Levity, Klo, Afterparty, Casti, Sidequest, Skilah, Tommy Toole, Frank Walker, Daniel Allen" }]},
  // PHXLIGHTS Solar System 2025
  { artist:"PHXLIGHTS: Solar Sound System 2025 — Day 1", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-04-04", price:"$129–$250+", promoter:"Relentless Beats", genre:"Festival (EDM)", url:"https://phxlightsfest.com", fest:true, source:"curated",
    lineup:[{ day:"Apr 4 (Fri) — The Mothership / The Invasion / The Fallout Silent Disco", artists:"NGHTMRE (headliner), Said The Sky, It's Murph, Hybrid Minds, Edward Joseph, Zero" }]},
  { artist:"PHXLIGHTS: Solar Sound System 2025 — Day 2", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-04-05", price:"$129–$250+", promoter:"Relentless Beats", genre:"Festival (EDM)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Apr 5 (Sat) — The Mothership / The Invasion / The Fallout Silent Disco", artists:"REZZ (headliner), Louis The Child (headliner), Of The Trees, Netsky, Kaivon, J. Worra, Jon Casey, Dark Mark" }]},
  // Warehouse 215 shows 2025
  { artist:"Warehouse Project: Tchami", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-06-07", price:"$35–$65", promoter:"Relentless Beats", genre:"House/Tech House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Jun 7", artists:"Tchami, Biscits, Azzecca, Max Styler" }]},
  { artist:"Warehouse Project: Gorgon City", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-06-08", price:"$35–$65", promoter:"Relentless Beats", genre:"House/Tech House", url:"", source:"curated",
    lineup:[{ day:"Jun 8", artists:"Gorgon City, Biscits, Azzecca, Max Styler" }]},
  { artist:"Chase & Status", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-06-21", price:"$30–$65", promoter:"Relentless Beats", genre:"Drum & Bass / Electronic", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Jun 21", artists:"Chase & Status" }]},
  { artist:"Deorro", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-08-22", price:"$25–$55", promoter:"Relentless Beats", genre:"Tech House / Electro House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Aug 22", artists:"Deorro" }]},
  { artist:"Above & Beyond", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-09-26", price:"$35–$75", promoter:"Relentless Beats", genre:"Trance / Progressive", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Sep 26", artists:"Above & Beyond" }]},
  { artist:"Malaa: Alter Ego (360° Set)", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-10-10", price:"$30–$60", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Oct 10", artists:"Malaa (Alter Ego 360° Set)" }]},
  { artist:"Kayzo", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-10-11", price:"$25–$55", promoter:"Relentless Beats", genre:"Hardstyle / Bass", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Oct 11", artists:"Kayzo" }]},
  // Illenium Rawhide Return
  { artist:"Illenium — Return to Rawhide", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2025-06-29", price:"$65–$150", promoter:"Relentless Beats", genre:"Melodic Bass", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Jun 29", artists:"Illenium, William Black" }]},
  // Warehouse 215 club shows
  { artist:"Nicole Moudaber + Klangkuenstler", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2024-10-25", price:"$20–$35", promoter:"Relentless Beats / Body Language", genre:"Techno / Hard Techno", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Oct 25", artists:"Nicole Moudaber, Klangkuenstler, AVISION, Aurora Halal, Helena Hauff, nasTia, AIROD, BIIA, Shlømo, Zorza, Ben Klock" }]},
  { artist:"Klangkuenstler", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2024-10-26", price:"$20–$35", promoter:"Relentless Beats / Body Language", genre:"Hard Techno", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Dombresky", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-02-14", price:"$20–$35", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Layton Giordani", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-02-15", price:"$20–$35", promoter:"Relentless Beats", genre:"Techno / Drumcode", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Odd Mob + Loofy + Zoe Gitter", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2026-03-13", price:"$20–$35", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  // Bassrush Arizona 2025 + Night Trip Festival Arizona 2025 (Insomniac weekend at WestWorld)
  { artist:"Bassrush Arizona 2025", venue:"WestWorld of Scottsdale (North Hall)", city:"Scottsdale", market:"phoenix", date:"2025-08-15", price:"$35–$75", promoter:"Insomniac", genre:"Bass Music", url:"https://www.insomniac.com", fest:true, source:"curated",
    lineup:[{ day:"Aug 15 (Fri) — 18+, 5 PM–2 AM", artists:"Ray Volpe, Black Tiger Sex Machine, Barely Alive, Midnight Tyrannosaurus, Jessica Audiffred, Pyke, Jon Casey, Jack-Lo; Witching Hour: Vampa b2b JEANIE" }]},
  { artist:"Night Trip Festival Arizona 2025", venue:"WestWorld of Scottsdale (North Hall)", city:"Scottsdale", market:"phoenix", date:"2025-08-16", price:"$35–$75", promoter:"Insomniac / Day Trip", genre:"Tech House / Deep House", url:"https://www.insomniac.com", fest:true, source:"curated",
    lineup:[{ day:"Aug 16 (Sat) — 18+, 5 PM–2 AM", artists:"Cloonee, Matroda, Dombresky, Walker & Royce, Jackie Hollander, San Pacho" }]},
  // Pacific Skies 2025
  { artist:"Pacific Skies 2025 ft. ILLENIUM", venue:"Wet 'n' Wild", city:"Glendale", market:"phoenix", date:"2025-08-29", price:"$75–$180", promoter:"Relentless Beats / Audiophile", genre:"Melodic Bass", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Aug 29", artists:"ILLENIUM + supporting artists" }]},
  // Goldrush Return to the West 2025
  { artist:"Goldrush: Return to the West — Night 1", venue:"Rawhide Western Town", city:"Chandler", market:"phoenix", date:"2025-09-12", price:"$99–$250+", promoter:"Relentless Beats / Universatile / Global Dance", genre:"Festival (Multi-genre)", url:"https://goldrushfestaz.com", fest:true, source:"curated",
    lineup:[{ day:"Sep 12", artists:"Excision, Illenium b2b Zeds Dead (World Debut), Major Lazer Soundsystem, Crankdat, Dillon Francis, Disco Lines, Benny Benassi, Destructo, Drinkurwater, Getter (Resurrection Set), Kyle Watson, Wax Motif, Hi-Lo, Space Laces, Infekt, Kompany, LF System, Wilkinson, William Black, Rinzen, Roddy Lima, Showtek (Hardstyle), Sub Zero Project, Ninajirachi, Steller, Nikita, ChaseWest, Slamm b2b Dan Molinari, Versa b2b MVRDA, Dennett" }]},
  { artist:"Goldrush: Return to the West — Night 2", venue:"Rawhide Western Town", city:"Chandler", market:"phoenix", date:"2025-09-13", price:"$99–$250+", promoter:"Relentless Beats / Universatile / Global Dance", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Sep 13", artists:"Excision, Illenium b2b Zeds Dead, Major Lazer Soundsystem, Crankdat, Dillon Francis, Disco Lines, Benny Benassi, Destructo, Getter (Resurrection Set), Kyle Watson, Wax Motif, Space Laces, Kompany, Eliminate, Wilkinson, William Black + more" }]},
  // Svdden Death VOYD — Forsaken Sands (CANCELED Sep 30, 2025; VOYD AZ debut moved to Decadence NYE 2025)
  { artist:"Svdden Death VOYD: Forsaken Sands [CANCELED]", venue:"Wild Horse Pass Festival Grounds", city:"Chandler", market:"phoenix", date:"2025-10-04", price:"$55–$110", promoter:"Relentless Beats / Aftershock", genre:"Riddim/Dubstep", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Oct 4 — EVENT CANCELED (Relentless Beats pulled show Sep 30; VOYD AZ debut moved to Decadence NYE)", artists:"Announced lineup: Svdden Death (VOYD set), Zomboy, Nimda, Vanfleet, Prosecute, beastboi. b2b HAMRO, PYKE b2b 7L" }]},
  // Body Language Fall 2025
  { artist:"Body Language Fall 2025 — Night 1", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-10-24", price:"$35–$80", promoter:"Relentless Beats / Body Language", genre:"Festival (House/Tech House)", url:"https://bodylanguagefest.com", fest:true, source:"curated",
    lineup:[{ day:"Oct 24", artists:"Gorgon City (headliner), Tchami b2b AC Slater, Noizu, KREAM, Amal Nemer, Ayybo, Marco Strous, MichaelBM, Rafael, Ranger Trucco, Edward Joseph, Valerie Stoss" }]},
  { artist:"Body Language Fall 2025 — Night 2", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-10-25", price:"$35–$80", promoter:"Relentless Beats / Body Language", genre:"Festival (House/Tech House)", url:"", fest:true, source:"curated" },
  // Obsidian 2025
  { artist:"Obsidian 2025 — Night 1", venue:"Eastlake Park Underpass", city:"Phoenix", market:"phoenix", date:"2025-11-07", price:"$40–$85", promoter:"Relentless Beats / Techno Snobs", genre:"Techno (Outdoor)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Nov 7–8 (2 nights, 18+)", artists:"Dax J, Deborah de Luca, Salome, Trym, Panteros666, Regal, Alignment, Callush, Oguz, JSTJR, Dunes of Dawn, Nicko Angelo b2b Blake England, Noises, The Pontiace House Project" }]},
  { artist:"Obsidian 2025 — Night 2", venue:"Eastlake Park Underpass", city:"Phoenix", market:"phoenix", date:"2025-11-08", price:"$40–$85", promoter:"Relentless Beats / Techno Snobs", genre:"Techno (Outdoor)", url:"", fest:true, source:"curated" },
  // DUSK 2025
  { artist:"DUSK Music Festival 2025", venue:"Jácome Plaza", city:"Tucson", market:"tucson", date:"2025-11-15", price:"$40–$80", promoter:"Relentless Beats / Rio Nuevo", genre:"Festival (Multi-genre)", url:"https://duskmusicfestival.com", fest:true, source:"curated",
    lineup:[{ day:"Nov 15–16 (3 stages, 30 artists)", artists:"Deorro, G-Eazy, INZO, Levity, Loud Luxury, ACRAZE (special guest), ALLEYCVT, WHIPPED CREAM, Pretty Sweet, Łaszewo, DRAMA, Loofy, Jigitz, Ekonovah, Vacations, Vundabar, HAYLA, Evangelia, Jessica Baio, maryjo" }]},
  // Decadence AZ 2025
  { artist:"Decadence Arizona 2025 — Night 1 (Portal of I11usions)", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-12-30", price:"$85–$250+", promoter:"Relentless Beats / Global Dance", genre:"Festival (Multi-genre)", url:"https://decadencearizona.com", fest:true, source:"curated",
    lineup:[{ day:"Dec 30", artists:"Adventure Club (Throwback Set), Ben Sterling, Brunello b2b KinAhau, Darren Styles, Hamdi, Hayden James, Kai Wachi b2b Sullivan King, Knock2, Max Styler, Meduza, Omri., Sammy Virji, Sara Landry, Whethan, Zedd, DMTRI, Gio Lucca, Stevie Nova" }]},
  { artist:"Decadence Arizona 2025 — Night 2 (NYE)", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-12-31", price:"$85–$250+", promoter:"Relentless Beats / Global Dance", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Dec 31", artists:"GRiZ (NYE Countdown Set), Chase & Status, Fisher, Green Velvet, Kaskade, Ky William, Level Up, Mike Posner, Odd Mob, Pedroz, PHRVA, Prunk, SG Lewis, Subtronics, Svdden Death presents VOYD, Tape B, Wax Motif (After Dark Set), Wakyin, Carrie Keller, DeathBeat, Michael Hooker" }]},
  // 9th & Jackson / standalone 2026 shows
  { artist:"Dim Mak Takeover Phoenix", venue:"9th & Jackson", city:"Phoenix", market:"phoenix", date:"2026-01-17", price:"$25–$40", promoter:"Dim Mak Records / Underground Nights", genre:"Electronic / House", url:"https://9thandjacksonphx.com", source:"curated",
    lineup:[{ day:"Jan 17 — 18+, 4 PM–2 AM (indoor + outdoor stages)", artists:"Laidback Luke, Cheyenne Giles, MADDS, Z3LLA, Tranzit, Alaskan Franks, Sean Watson, Coco Disco, NOOD, Fairy Dvst, Casti, Marcus Craft" }]},
  { artist:"Joseph Capriati", venue:"9th & Jackson", city:"Phoenix", market:"phoenix", date:"2026-02-20", price:"$25–$40", promoter:"9th & Jackson", genre:"Techno", url:"https://9thandjacksonphx.com", source:"curated",
    lineup:[{ day:"Feb 20", artists:"Joseph Capriati, Stacey Pullen" }]},
  { artist:"Night Trip Arizona: D.O.D & Gudfella", venue:"9th & Jackson", city:"Phoenix", market:"phoenix", date:"2026-03-26", price:"$25–$40", promoter:"Insomniac / Day Trip", genre:"Electro House / House", url:"https://www.insomniac.com", source:"curated",
    lineup:[{ day:"Mar 26 — 18+, 9 PM–2 AM", artists:"D.O.D, Gudfella" }]},
  // Walter Where?House — shows (Oct 2024 – Apr 2026)
  { artist:"Bob Moses", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-05-04", price:"$25–$45", promoter:"Walter Where?House", genre:"Indie Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Kruder & Dorfmeister", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-09-29", price:"$30–$55", promoter:"Walter Where?House", genre:"Trip-Hop/Downtempo", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Ternion Sound", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-11-09", price:"$20–$35", promoter:"Walter Where?House", genre:"Bass Music / Halftime", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Mark Farina", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-12-20", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"VNSSA + Mary Droppinz", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-12-21", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Sama' Abdulhadi", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-12-27", price:"$20–$35", promoter:"Walter Where?House", genre:"Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Dec 27", artists:"Sama' Abdulhadi, Jo, Arsenal" }]},
  { artist:"Maddy O'Neal", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-12-28", price:"$20–$35", promoter:"Walter Where?House", genre:"Electronic / Bass", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"A-Trak + N2N", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-12-31", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Open Format", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Dec 31 (NYE 2024)", artists:"A-Trak, N2N" }]},
  { artist:"Stacey Pullen", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-01-03", price:"$20–$35", promoter:"Walter Where?House", genre:"Techno / Detroit", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Tim Green", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-01-04", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Jan 4", artists:"Tim Green, .viktop" }]},
  { artist:"Random Rab + Skysia", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-01-10", price:"$20–$35", promoter:"Walter Where?House", genre:"Psychedelic / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Moodymann + Carl Craig", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-01-11", price:"$25–$45", promoter:"Walter Where?House", genre:"Detroit House/Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Christian Martin", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-01-17", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Jan 17", artists:"Christian Martin, Ghost Effect" }]},
  { artist:"Shaded + Tara Brooks", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-01-18", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Jan 18", artists:"Shaded, Tara Brooks, Jørgen" }]},
  { artist:"Miss Monique", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-02-21", price:"$25–$40", promoter:"Walter Where?House", genre:"Melodic Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Poolside", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-03-07", price:"$25–$45", promoter:"Walter Where?House", genre:"Indie Electronic / Disco", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Flight Facilities", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-03-08", price:"$25–$45", promoter:"Walter Where?House", genre:"Electronic / Indie Dance", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Techno Snobs: Hiroko Yamamura", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-04-11", price:"$20–$35", promoter:"Walter Where?House / Techno Snobs", genre:"Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Sultan + CeCe", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-09-12", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Sep 12", artists:"Sultan, CeCe, leisan" }]},
  { artist:"FJAAK", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-09-13", price:"$25–$45", promoter:"Walter Where?House", genre:"Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Sep 13", artists:"FJAAK, Bloka" }]},
  { artist:"Matthias Tanzmann", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-09-19", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Sep 19", artists:"Matthias Tanzmann, Ray Mono" }]},
  { artist:"Life on Planets + Coco & Breezy", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-09-20", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Sasha", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-09-26", price:"$25–$45", promoter:"Walter Studios", genre:"Progressive House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"BAYNK + mindchatter", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-09-27", price:"$20–$35", promoter:"Walter Where?House", genre:"Indie Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Sep 27", artists:"BAYNK, mindchatter, Louis V" }]},
  { artist:"Kyle Walker", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-10-03", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Oct 3", artists:"Kyle Walker, SLUGG" }]},
  { artist:"MNTRA", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-10-04", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"LP Giobbi", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-10-10", price:"$25–$45", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Claptone", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-10-11", price:"$25–$45", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Oct 11", artists:"Claptone, Jur" }]},
  { artist:"CA7RIEL & Paco Amoroso", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-10-15", price:"$20–$35", promoter:"Walter Where?House", genre:"Urban / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Bonobo", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-11-07", price:"$25–$45", promoter:"Walter Where?House", genre:"Downtempo / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Murphy's Law + Anatta", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-11-15", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Hernan Cattaneo + Lee Burridge", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-11-26", price:"$25–$45", promoter:"Walter Where?House", genre:"Progressive / Deep House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Space 92", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-11-28", price:"$20–$35", promoter:"Walter Where?House", genre:"Hard Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Martin Ikin", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-11-29", price:"$20–$35", promoter:"Walter Where?House", genre:"Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Sam Divine", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-12-05", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Infected Mushroom", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-12-06", price:"$25–$45", promoter:"Walter Where?House", genre:"Psytrance / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Paul Oakenfold", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-12-13", price:"$25–$45", promoter:"Walter Where?House", genre:"Trance", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Super Future + Wreckno", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-12-19", price:"$20–$35", promoter:"Walter Where?House", genre:"Bass / Dubstep", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Justin Martin", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-12-31", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Dec 31 (NYE 2025)", artists:"Justin Martin" }]},
  { artist:"Worakls", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-01-03", price:"$20–$35", promoter:"Walter Where?House", genre:"Melodic House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Walker & Royce", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-01-31", price:"$25–$45", promoter:"Insomniac / Walter Where?House", genre:"Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Jan 31 — 21+, 10 PM–2 AM", artists:"Walker & Royce" }]},
  { artist:"The Martinez Brothers", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-02-06", price:"$25–$45", promoter:"Walter Where?House", genre:"House / Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Sacha Robotti", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-02-28", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Polo & Pan (DJ Set) + Neil Frances", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-03-06", price:"$25–$45", promoter:"Walter Where?House", genre:"Electro Pop / Indie Dance", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Flava D", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-03-07", price:"$20–$35", promoter:"Walter Where?House", genre:"Garage / Bass", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Katya Zamolodchikova", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-03-12", price:"$20–$35", promoter:"Walter Where?House", genre:"Electronic / Performance", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"KILIMANJARO", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-03-13", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"bullet tooth + Shermanology", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-03-14", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Interplanetary Criminal", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-03-20", price:"$20–$35", promoter:"Walter Where?House", genre:"UK Bass / Garage", url:"https://walterwherehouse.com", wwh:true, source:"curated",
    lineup:[{ day:"Mar 20", artists:"Interplanetary Criminal, Twyatt Earp, Animate" }]},
  { artist:"Nora en Pure + Bedi", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-03-21", price:"$25–$45", promoter:"Walter Where?House", genre:"Melodic House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Alix + Peter Blick", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-03-27", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Deeper Purpose", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-03-28", price:"$20–$35", promoter:"Walter Where?House", genre:"Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"OMNOM", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-03", price:"$20–$35", promoter:"Walter Where?House", genre:"House/Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Anfisa Letyago + Disco Zombie + Mâ (AZ)", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-04", price:"$20–$35", promoter:"Walter Where?House", genre:"Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 4", artists:"Anfisa Letyago, Disco Zombie, Mâ (AZ)" }]},
  { artist:"OMRI. + CeCe", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-10", price:"$20–$35", promoter:"Walter Where?House", genre:"Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 10", artists:"OMRI., CeCe" }]},
  { artist:"Carl Craig + CD-6", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-11", price:"$25–$45", promoter:"Walter Where?House", genre:"Techno/Detroit", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 11", artists:"Carl Craig, CD-6" }]},
  { artist:"Kaleena Zanders + Eliza Rose + DJ Freedom", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-17", price:"$20–$35", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 17", artists:"Kaleena Zanders, Eliza Rose, DJ Freedom" }]},
  { artist:"Adam Ten + Riche + Amir Hakak", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-24", price:"$20–$35", promoter:"Walter Where?House / Independent", genre:"Melodic Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 24", artists:"Adam Ten, Riche, Amir Hakak" }]},
  { artist:"Gio Lucca + Baggins", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-25", price:"$20–$35", promoter:"Walter Where?House", genre:"House/Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 25", artists:"Gio Lucca, Baggins" }]},
  { artist:"The Botanist + Rafael + Valerie Stoss", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-01", price:"$20–$35", promoter:"Walter Where?House", genre:"Organic House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"May 1", artists:"The Botanist, Rafael, Valerie Stoss" }]},
  { artist:"N2N + ero808", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-09", price:"$20–$35", promoter:"Walter Where?House", genre:"House/Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"May 9", artists:"N2N, ero808" }]},
  { artist:"Effy + Mall Grab + Alix Rico", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-15", price:"$20–$35", promoter:"Walter Where?House", genre:"Lo-fi House/Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"May 15", artists:"Effy, Mall Grab, Alix Rico" }]},
  { artist:"Poranguí", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-16", price:"$20–$35", promoter:"Walter Where?House", genre:"World / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Kitty Kat Ball", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-19", price:"$20–$35", promoter:"Walter Where?House", genre:"House / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Definitive + Toman + Casey Zanni", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-22", price:"$20–$35", promoter:"Walter Where?House", genre:"Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"May 22", artists:"Definitive, Toman, Casey Zanni" }]},
  { artist:"Ranger Trucco", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-23", price:"$20–$35", promoter:"Walter Where?House", genre:"Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Hot Since 82 + Anatta", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-24", price:"$25–$45", promoter:"Walter Where?House", genre:"Deep House / Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"May 24", artists:"Hot Since 82, Anatta" }]},
  { artist:"idgaFNK + Eazybaked + Distinct Motive", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-31", price:"$20–$35", promoter:"Walter Where?House", genre:"Bass / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"May 31", artists:"idgaFNK, Eazybaked, Distinct Motive" }]},
  { artist:"idgaFNK + Taiki Nulight", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-06-05", price:"$20–$35", promoter:"Walter Where?House", genre:"Bass / Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Jun 5", artists:"idgaFNK, Taiki Nulight" }]},
  { artist:"Big Gigantic: 360 House Party + Smoakland", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-08-01", price:"$25–$45", promoter:"Walter Where?House", genre:"Funk / Electronic / Live", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Aug 1 — 360 House Party", artists:"Big Gigantic (live), Smoakland" }]},
  // Breakaway 2026
  { artist:"Breakaway Arizona 2026 — Day 1", venue:"Sloan Park Festival Grounds", city:"Mesa", market:"phoenix", date:"2026-04-24", price:"$30–$200+", promoter:"Breakaway × Relentless Beats", genre:"Festival (Multi-genre)", url:"https://www.breakawayfestival.com/festival/arizona-2026", fest:true, source:"curated",
    lineup:[{ day:"Fri Apr 24 — (day-by-day splits TBA; full festival lineup)", artists:"Marshmello, Kygo, ISOxo, James Hype, Loud Luxury, Dr. Fresch, Effin, Grabbitz, Mersiv, Cassian, TRUTH, Angrybaby, Xandra, ALIGN, SHIMA, Steller, Jon Casey, MPH, Arthi, Disco Dom, Delato, Leesh, Livviep" }]},
  { artist:"Breakaway Arizona 2026 — Day 2", venue:"Sloan Park Festival Grounds", city:"Mesa", market:"phoenix", date:"2026-04-25", price:"$30–$200+", promoter:"Breakaway × Relentless Beats", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Sat Apr 25 — (day-by-day splits TBA; full festival lineup)", artists:"Kygo, ISOxo, James Hype, Loud Luxury, Dr. Fresch, Mersiv, Grabbitz, Jon Casey, TRUTH, Stellar, Effin, MPH, Cassian, Disco Dom, Angrybaby, SHIMA, Xandra, ALIGN, Arthi, Delato, Leesh, Livviep" }]},
  // System Overload 2026 (debut bass festival — Relentless Beats / Aftershock)
  { artist:"System Overload 2026 — Night 1", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2026-02-27", price:"$55–$120", promoter:"Relentless Beats / Aftershock", genre:"Festival (Bass/Dubstep)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Feb 27–28 (18+)", artists:"SLANDER, Wooli, Liquid Stranger, NGHTMRE, Eptic, HOL!, Akeos, Blvnkspvce b2b Sqishi, Bommer, Canabliss, Codd Dubz, Don Jamal, M?stic, MADVKTM (Mad Dubz b2b VKTM), Mile32, Richard Finger, Samplifire, Sisto b2b 7L, Stoned to Death, Sythyst b2b Hexxa, The Resistance, Warlord" }]},
  { artist:"System Overload 2026 — Night 2", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2026-02-28", price:"$55–$120", promoter:"Relentless Beats / Aftershock", genre:"Festival (Bass/Dubstep)", url:"", fest:true, source:"curated" },
  // Crankdat
  { artist:"Crankdat", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2026-05-09", price:"$95+", promoter:"Relentless Beats / Aftershock", genre:"Bass/Dubstep", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"May 9", artists:"Crankdat, Zingara, Zen Selekta, Casey Club" }]},
  // Goldrush Midnight Riders 2026
  { artist:"Goldrush: Midnight Riders 2026 — Night 1", venue:"Rawhide Western Town", city:"Chandler", market:"phoenix", date:"2026-09-11", price:"$227+", promoter:"Relentless Beats", genre:"Festival (Multi-genre)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Sep 11–12", artists:"Lineup TBA — follow @GoldrushFestAZ" }]},
  { artist:"Goldrush: Midnight Riders 2026 — Night 2", venue:"Rawhide Western Town", city:"Chandler", market:"phoenix", date:"2026-09-12", price:"$227+", promoter:"Relentless Beats", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated" },
  // Decadence AZ 2026
  { artist:"Decadence Arizona 2026", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2026-12-30", price:"$85–$250+", promoter:"Relentless Beats", genre:"Festival (Multi-genre)", url:"https://decadencearizona.com", fest:true, source:"curated",
    lineup:[{ day:"Dec 30–31", artists:"Lineup TBA — follow @DecadenceArizona" }]},

  // ── Sunbar Tempe — club shows (Oct 2024 – Apr 2026) ──────────────────────
  { artist:"Gammer", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2024-10-04", price:"$15–$25", promoter:"Relentless Beats", genre:"Hardstyle / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Chris Lorenzo (Late Checkout)", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2024-10-11", price:"$15–$25", promoter:"Relentless Beats", genre:"House / UK Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Hamdi", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2024-10-18", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Halftime", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Nurko", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2024-10-25", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Nero", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2024-11-15", price:"$20–$30", promoter:"Relentless Beats", genre:"Drum & Bass / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Layz", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2024-11-23", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"SABAI", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2024-12-14", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic Bass / Future Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Bear Grillz", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2024-12-20", price:"$20–$30", promoter:"Relentless Beats", genre:"Bass / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Feed Me", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2024-12-21", price:"$15–$25", promoter:"Relentless Beats", genre:"Electro / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Sosa", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-03-01", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"SIDEPIECE", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-04-11", price:"$20–$30", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Darude + Kristina Sky", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-04-12", price:"$15–$25", promoter:"Relentless Beats", genre:"Trance / Dance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"JSTJR", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-04-26", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass House / Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Cosmic Gate", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-05-03", price:"$20–$30", promoter:"Relentless Beats", genre:"Trance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Mall Grab", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-05-08", price:"$15–$25", promoter:"Relentless Beats", genre:"Lo-fi House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Dubloadz", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-05-24", price:"$15–$25", promoter:"Relentless Beats", genre:"Riddim / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Benny Benassi", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-05-25", price:"$20–$30", promoter:"Relentless Beats", genre:"Electro House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Wuki", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-05-31", price:"$20–$30", promoter:"Relentless Beats", genre:"Tech House / Bass House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Eptic", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-06-06", price:"$20–$30", promoter:"Relentless Beats", genre:"Dubstep / Riddim", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Kill The Noise", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-06-07", price:"$20–$30", promoter:"Relentless Beats", genre:"Bass / Electro", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"SayMyName", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-06-14", price:"$20–$30", promoter:"Relentless Beats", genre:"Trap / Bass House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Öwnboss", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-06-20", price:"$20–$30", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Mark Knight", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-06-27", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"BONNIE X CLYDE", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-06-28", price:"$20–$30", promoter:"Relentless Beats", genre:"Future Bass / Pop Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"HOL!", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-07-11", price:"$20–$30", promoter:"Relentless Beats", genre:"Riddim / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Notion", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-08-09", price:"$15–$25", promoter:"Relentless Beats", genre:"Drum & Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Marsh", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-08-16", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic House / Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"KETTAMA", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-09-19", price:"$15–$25", promoter:"Relentless Beats", genre:"Techno / Hard Techno", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"NOTD", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-09-20", price:"$15–$25", promoter:"Relentless Beats", genre:"Pop Electronic / Dance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"YDG", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-10-17", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Trap", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Trivecta", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-11-07", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"PhaseOne", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-11-21", price:"$20–$30", promoter:"Relentless Beats / Aftershock", genre:"Riddim / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Friction", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-11-26", price:"$15–$25", promoter:"Relentless Beats", genre:"Drum & Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Bear Grillz", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2025-12-26", price:"$20–$30", promoter:"Relentless Beats", genre:"Bass / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Kompany", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-01-16", price:"$20–$30", promoter:"Relentless Beats / Aftershock", genre:"Riddim / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Borgore", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-01-17", price:"$20–$30", promoter:"Relentless Beats", genre:"Dubstep / Trap", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Valentino Khan", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-01-30", price:"$20–$30", promoter:"Relentless Beats", genre:"Tech House / Trap", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Habstrakt", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-01-31", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Drezo", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-02-14", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House / House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Gabriel & Dresden", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-02-15", price:"$15–$25", promoter:"Relentless Beats", genre:"Trance / Progressive", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Danny Avila", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-02-20", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House / Electro", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"AYYBO", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-02-28", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Dennett", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-03-13", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Ookay", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-03-14", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House / Trap", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Midnight Tyrannosaurus", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-03-20", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Jkyl & Hyde + Moksi", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-03-27", price:"$15–$25", promoter:"Relentless Beats", genre:"Electro / Bass House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Mar 27", artists:"Jkyl & Hyde (Duo), Moksi, STVSH" }]},
  { artist:"Maddy O'Neal", venue:"Sunbar", city:"Tempe", market:"phoenix", date:"2026-03-28", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Electronic", url:"https://relentlessbeats.com", source:"curated" },

  // ── Darkstar Tempe — club shows (Oct 2024 – Apr 2026) ──────────────────────
  { artist:"AYYBO", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2024-11-29", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Massane", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2024-11-30", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic House / Techno", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Simon Patterson", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2024-12-07", price:"$15–$25", promoter:"Relentless Beats", genre:"Trance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Mat Zo", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2024-12-14", price:"$15–$25", promoter:"Relentless Beats", genre:"Trance / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Très Mortimer", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2024-12-20", price:"$15–$25", promoter:"Relentless Beats", genre:"Electronic / Dance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Midnight Tyrannosaurus", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2024-12-21", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"GUDFELLA", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2024-12-31", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House / Electro House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Dec 31 (NYE 2024)", artists:"GUDFELLA" }]},
  { artist:"Luttrell", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-01-10", price:"$20–$30", promoter:"Relentless Beats", genre:"Progressive / Melodic House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Gabriel & Dresden", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-01-11", price:"$20–$30", promoter:"Relentless Beats", genre:"Trance / Progressive", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"IMANU", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-01-18", price:"$20–$30", promoter:"Relentless Beats", genre:"Drum & Bass / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Chris Luno", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-01-25", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Buku", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-01-31", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"The Heyz", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-02-07", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"VKTM", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-04-12", price:"$15–$25", promoter:"Relentless Beats / Aftershock", genre:"Riddim / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Elephante", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-04-19", price:"$20–$30", promoter:"Relentless Beats", genre:"Progressive / Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Beauz", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-04-25", price:"$15–$25", promoter:"Relentless Beats", genre:"Pop / Future Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"1788-L", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-05-10", price:"$20–$30", promoter:"Relentless Beats", genre:"Bass / Experimental Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Tisoki", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-08-31", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Know Good", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-09-20", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Hills", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-09-26", price:"$15–$25", promoter:"Relentless Beats", genre:"Electronic / Indie Dance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Lumasi", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-09-27", price:"$15–$25", promoter:"Relentless Beats", genre:"Bass / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Kamino", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-10-04", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Elephante", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-10-10", price:"$20–$30", promoter:"Relentless Beats", genre:"Progressive / Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"DJ Mandy", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-10-18", price:"$15–$25", promoter:"Relentless Beats", genre:"Techno", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Grabbitz", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-11-07", price:"$20–$30", promoter:"Relentless Beats", genre:"Melodic Bass / Rock Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"VLCN", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-11-08", price:"$20–$30", promoter:"Relentless Beats / Aftershock", genre:"Bass / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Chmura + Duffrey", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-11-28", price:"$15–$25", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Gentlemens Club", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-12-06", price:"$20–$30", promoter:"Relentless Beats", genre:"Bass / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Öwnboss", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2025-12-12", price:"$20–$30", promoter:"Relentless Beats", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Dom Corleo + Subiibabii", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-01-02", price:"$15–$25", promoter:"Relentless Beats", genre:"Electronic / Urban", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Jan 2", artists:"Dom Corleo, Subiibabii, DJ GOTH, Yaro" }]},
  { artist:"Braydon Terzo", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-01-16", price:"$15–$25", promoter:"Relentless Beats", genre:"Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Ninajirachi", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-01-17", price:"$15–$25", promoter:"Relentless Beats", genre:"Electronic / Dance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Grum", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-01-23", price:"$20–$30", promoter:"Relentless Beats", genre:"Trance / Progressive", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Skysia + Josh Teed", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-01-24", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Nifra", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-02-13", price:"$20–$30", promoter:"Relentless Beats", genre:"Trance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Nikita The Wicked", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-03-06", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic Techno / Trance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Last Heroes", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-03-20", price:"$15–$25", promoter:"Relentless Beats", genre:"Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Tokyo Machine + Skybreak", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-03-21", price:"$15–$25", promoter:"Relentless Beats", genre:"Electro / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Yetep", venue:"Darkstar", city:"Tempe", market:"phoenix", date:"2026-03-28", price:"$15–$25", promoter:"Relentless Beats", genre:"Future Bass / Electronic", url:"https://relentlessbeats.com", source:"curated" },

  // ── Rawhide standalone shows ───────────────────────────────────────────────
  { artist:"Subtronics (Cyclops Desert)", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2025-03-07", price:"$45–$75", promoter:"Relentless Beats / Aftershock", genre:"Riddim / Dubstep", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Mar 7", artists:"Subtronics (Cyclops set)" }]},
  { artist:"Wooli", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2025-08-30", price:"$35–$60", promoter:"Relentless Beats / Aftershock", genre:"Bass / Dubstep", url:"https://relentlessbeats.com", source:"curated" },

  // ── The Van Buren — Phoenix club shows (Oct 2024 – Apr 2026) ──────────────
  { artist:"Hayden James", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2024-10-11", price:"$25–$40", promoter:"Relentless Beats / Live Nation", genre:"House / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Of The Trees", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2024-11-22", price:"$25–$40", promoter:"Relentless Beats / Live Nation", genre:"Bass Music", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"ATLiens", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2025-01-11", price:"$25–$40", promoter:"Relentless Beats / Live Nation", genre:"Bass / Trap", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Deathpact", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2025-03-15", price:"$25–$40", promoter:"Relentless Beats / Live Nation", genre:"Bass Music", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Daily Bread", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2025-03-28", price:"$25–$40", promoter:"Relentless Beats / Live Nation", genre:"Drum & Bass / Jungle", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Elderbrook", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2025-04-09", price:"$30–$50", promoter:"Relentless Beats / Live Nation", genre:"Indie Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Ben Böhmer (Live)", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2025-04-11", price:"$30–$50", promoter:"Relentless Beats / Live Nation", genre:"Melodic House & Techno", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"bunt.", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2025-09-25", price:"$25–$40", promoter:"Relentless Beats / Live Nation", genre:"Organic House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"ARMNHMR", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2025-10-03", price:"$30–$50", promoter:"Relentless Beats / Live Nation", genre:"Future Bass / Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"it's murph", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2025-11-21", price:"$30–$50", promoter:"Relentless Beats / Live Nation", genre:"Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Ray Volpe", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2026-01-30", price:"$25–$40", promoter:"Relentless Beats / Live Nation", genre:"Riddim / Dubstep", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Jessica Audiffred", venue:"The Van Buren", city:"Phoenix", market:"phoenix", date:"2026-06-20", price:"$25–$40", promoter:"Relentless Beats / Live Nation", genre:"Bass Music / Dubstep", url:"https://relentlessbeats.com", source:"curated" },

  // ── Clubhouse at Maya — Scottsdale nightclub (Oct 2024 – Apr 2026) ─────────
  { artist:"Joyryde", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-10-12", price:"$20–$35", promoter:"Relentless Beats / RHG & Spellbound", genre:"House / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Wax Motif", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-10-19", price:"$20–$35", promoter:"Relentless Beats / RHG & Spellbound", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Party Favor", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-10-26", price:"$20–$35", promoter:"Relentless Beats / RHG & Spellbound", genre:"Bass House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Chris Lake", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-11-01", price:"$30–$50", promoter:"Relentless Beats / RHG & Spellbound", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Nov 1 — Super Unnatural Afterparty Night 1", artists:"Chris Lake" }]},
  { artist:"Patrick Topping", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-11-02", price:"$30–$50", promoter:"Relentless Beats / RHG & Spellbound", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Nov 2 — Super Unnatural Afterparty Night 2", artists:"Patrick Topping" }]},
  { artist:"Bob Moses", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-11-08", price:"$20–$35", promoter:"Relentless Beats / RHG & Spellbound", genre:"Electronic / Indie Dance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"BONNIE X CLYDE", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-11-16", price:"$20–$35", promoter:"Relentless Beats / RHG & Spellbound", genre:"Bass House / Dance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"James Kennedy", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-11-23", price:"$20–$35", promoter:"Relentless Beats / RHG & Spellbound", genre:"Electronic / Pop", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"RL Grime", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-12-14", price:"$30–$50", promoter:"Relentless Beats / RHG & Spellbound", genre:"Trap / Hip Hop", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Madeon (DJ Set)", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2024-12-31", price:"$30–$50", promoter:"Relentless Beats / RHG & Spellbound", genre:"Electro Pop / Dance", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"ILLENIUM", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2025-02-08", price:"$30–$50", promoter:"Relentless Beats / RHG & Spellbound", genre:"Melodic Dubstep / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Pauly D", venue:"Clubhouse at Maya", city:"Scottsdale", market:"phoenix", date:"2025-11-15", price:"$20–$35", promoter:"Relentless Beats / RHG & Spellbound", genre:"Electronic / Pop", url:"https://relentlessbeats.com", source:"curated" },

  // ── Maya Dayclub — Scottsdale outdoor pool (pool season Mar–Sep) ───────────
  { artist:"Troyboi", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-03-09", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Trap / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Odd Mob", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-03-16", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Flux Pavilion", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-03-23", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Dubstep / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Audien", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-04-18", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Trance / Electro House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Apr 18 — Breakaway Afterparty Day 1", artists:"Audien" }]},
  { artist:"Adventure Club", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-04-27", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Dubstep / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Layton Giordani", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-05-04", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Techno", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"May 4 — Cinco de Maya", artists:"Layton Giordani" }]},
  { artist:"Malaa", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-05-25", price:"$35–$55", promoter:"Relentless Beats / Riot Hospitality", genre:"House / Tech House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"May 25 — Memorial Day Weekend", artists:"Malaa" }]},
  { artist:"Yellow Claw", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-05-26", price:"$35–$55", promoter:"Relentless Beats / Riot Hospitality", genre:"Trap / Bass House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"May 26 — Memorial Day Weekend", artists:"Yellow Claw" }]},
  { artist:"Porter Robinson", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-06-08", price:"$35–$55", promoter:"Relentless Beats / Riot Hospitality", genre:"Electronic / Future Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Tchami", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-06-22", price:"$35–$55", promoter:"Relentless Beats / Riot Hospitality", genre:"Future House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"San Pacho", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-07-03", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Jul 3 — Independence Weekend", artists:"San Pacho" }]},
  { artist:"Subtronics", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-07-04", price:"$35–$55", promoter:"Relentless Beats / Riot Hospitality", genre:"Riddim / Dubstep", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Jul 4 — Independence Day", artists:"Subtronics" }]},
  { artist:"Joyryde", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-07-20", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"House / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Kaivon", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-07-27", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Future Bass / Melodic Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Ship Wrek", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-08-03", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"House / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Tom & Collins", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-08-17", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Chris Lorenzo", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-08-31", price:"$35–$55", promoter:"Relentless Beats / Riot Hospitality", genre:"Bass House / Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"SOSA", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-09-01", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"House / Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"MORTEN", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-11-26", price:"$35–$55", promoter:"Relentless Beats / Riot Hospitality", genre:"Big Room / Progressive House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Topic", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-12-12", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Dance / Pop Electronic", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Odd Mob + Pedroz", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2025-12-31", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Dec 31 — NYE", artists:"Odd Mob, Pedroz" }]},
  { artist:"DJ Snake", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2026-04-19", price:"$35–$55", promoter:"Relentless Beats / Riot Hospitality", genre:"Electronic / Trap", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Wuki", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2026-05-03", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Electro House / Bass", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"Roddy Lima", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2026-05-22", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
  { artist:"San Pacho", venue:"Maya Dayclub", city:"Scottsdale", market:"phoenix", date:"2026-05-24", price:"$20–$35", promoter:"Relentless Beats / Riot Hospitality", genre:"Tech House", url:"https://relentlessbeats.com", source:"curated" },
];

// deduplicate: if a TM event matches a curated event on same date+similar artist name, prefer curated
function dedup(tmEvents, curated) {
  const curatedKeys = new Set(curated.map(e => e.date + '|' + e.artist.toLowerCase().slice(0,20)));
  return tmEvents.filter(ev => {
    const key = ev.date + '|' + ev.artist.toLowerCase().slice(0,20);
    // also skip if venue name contains "Rawhide" or "Phoenix Raceway" and it's a festival — likely already in curated
    return !curatedKeys.has(key);
  });
}

async function main() {
  console.log('=== Arizona EDM Calendar Build ===');
  console.log('Fetching Ticketmaster data...');

  let tmRaw = [];
  for (const m of MARKETS) {
    try {
      const events = await fetchTM(m.city, m.stateCode);
      console.log(`  ${m.city}: ${events.length} raw events`);
      const edm = events.filter(isEDM);
      console.log(`  ${m.city}: ${edm.length} EDM events`);
      const mapped = edm.map(e => tmToEvent(e, m.id));
      tmRaw = tmRaw.concat(mapped);
    } catch(err) {
      console.warn(`  Warning: TM fetch failed for ${m.city}:`, err.message);
    }
    await sleep(500);
  }

  // Also fetch for surrounding cities that count as Phoenix market
  const surroundCities = ['Scottsdale', 'Tempe', 'Chandler', 'Mesa', 'Glendale', 'Avondale'];
  for (const city of surroundCities) {
    try {
      const events = await fetchTM(city, 'AZ');
      const edm = events.filter(isEDM);
      const mapped = edm.map(e => tmToEvent(e, 'phoenix'));
      tmRaw = tmRaw.concat(mapped);
      await sleep(300);
    } catch(err) {
      console.warn(`  Warning: TM fetch failed for ${city}:`, err.message);
    }
  }

  // Dedup TM events against curated
  const tmFiltered = dedup(tmRaw, CURATED);
  console.log(`TM events after dedup: ${tmFiltered.length}`);

  // Merge: curated first (authoritative), then TM additions
  const allEvents = [...CURATED, ...tmFiltered];

  // Sort by date
  allEvents.sort((a, b) => a.date.localeCompare(b.date));

  console.log(`Total events: ${allEvents.length}`);

  // Build timestamp
  const now = new Date();
  const builtAt = now.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });

  // Read template
  const template = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  // Inject data
  const output = template
    .replace('const EVENTS = window.__EVENTS__ || [];', `const EVENTS = ${JSON.stringify(allEvents, null, 0)};`)
    .replace("const BUILT_AT = window.__BUILT_AT__ || 'unknown';", `const BUILT_AT = '${builtAt}';`);

  // Write to dist/
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), output);
  console.log(`Built dist/index.html (${(output.length/1024).toFixed(1)} KB)`);
  console.log('=== Build complete ===');
}

main().catch(err => { console.error('Build failed:', err); process.exit(1); });
