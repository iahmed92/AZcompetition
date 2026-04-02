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

function isEDM(event) {
  const name = (event.name || '').toLowerCase();
  const genre = ((event.classifications?.[0]?.genre?.name) || '').toLowerCase();
  const subgenre = ((event.classifications?.[0]?.subGenre?.name) || '').toLowerCase();
  const segment = ((event.classifications?.[0]?.segment?.name) || '').toLowerCase();
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
  // Body Language Fest 2025
  { artist:"Body Language Fest 2025 — Night 1", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-02-16", price:"$65–$150", promoter:"Relentless Beats / RBDeep", genre:"Festival (House/Techno)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Feb 16", artists:"Sofi Tukker + major house & techno artists" }]},
  { artist:"Body Language Fest 2025 — Night 2 (Drumcode)", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-02-17", price:"$65–$150", promoter:"Relentless Beats / RBDeep", genre:"Festival (House/Techno)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Feb 17", artists:"Drumcode Records stage takeover + supporting artists" }]},
  // Gem & Jam 2025
  { artist:"Gem & Jam Festival 2025", venue:"Rillito Regional Park", city:"Tucson", market:"tucson", date:"2025-02-06", price:"$120–$300+", promoter:"Gem & Jam", genre:"Festival (Jam/Electronic)", url:"https://gemandjam.com", fest:true, source:"curated",
    lineup:[{ day:"Feb 6–9", artists:"The Polish Ambassador, Desert Dwellers, Mr. Bill, Moontricks, lespecial + 50 more artists" }]},
  // System Overload 2025
  { artist:"System Overload 2025 — Night 1", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2025-02-27", price:"$55–$120", promoter:"Relentless Beats", genre:"Festival (Bass)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Feb 27–28", artists:"Liquid Stranger, Slander, Wooli + supporting bass artists" }]},
  { artist:"System Overload 2025 — Night 2", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2025-02-28", price:"$55–$120", promoter:"Relentless Beats", genre:"Festival (Bass)", url:"", fest:true, source:"curated" },
  // PHXLIGHTS Solar System 2025
  { artist:"PHXLIGHTS: Solar Sound System 2025 — Day 1", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-04-04", price:"$129–$250+", promoter:"Relentless Beats", genre:"Festival (EDM)", url:"https://phxlightsfest.com", fest:true, source:"curated",
    lineup:[{ day:"Apr 4–5", artists:"REZZ, Louis The Child, NGHTMRE, Of The Trees, Said The Sky, Netsky, It's Murph, Kaivon, Hybrid Minds, J. Worra, Zero, Jon Casey, Edward Joseph, Dark Mark + 20 more" }]},
  { artist:"PHXLIGHTS: Solar Sound System 2025 — Day 2", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-04-05", price:"$129–$250+", promoter:"Relentless Beats", genre:"Festival (EDM)", url:"", fest:true, source:"curated" },
  // Warehouse Project 2025
  { artist:"Warehouse Project: Tchami", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-06-07", price:"$35–$65", promoter:"Relentless Beats", genre:"House/Tech House", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Jun 7", artists:"Tchami + supporting acts" }]},
  { artist:"Warehouse Project: Gorgon City", venue:"Warehouse 215", city:"Phoenix", market:"phoenix", date:"2025-06-08", price:"$35–$65", promoter:"Relentless Beats", genre:"House/Tech House", url:"", source:"curated",
    lineup:[{ day:"Jun 8", artists:"Gorgon City + supporting acts" }]},
  // Illenium Rawhide Return
  { artist:"Illenium — Return to Rawhide", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2025-06-29", price:"$65–$150", promoter:"Relentless Beats", genre:"Melodic Bass", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Jun 29", artists:"Illenium, William Black" }]},
  // Pacific Skies 2025
  { artist:"Pacific Skies 2025 ft. ILLENIUM", venue:"Wet 'n' Wild", city:"Glendale", market:"phoenix", date:"2025-08-29", price:"$75–$180", promoter:"Relentless Beats / Audiophile", genre:"Melodic Bass", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Aug 29", artists:"ILLENIUM + supporting artists" }]},
  // Goldrush Return to the West 2025
  { artist:"Goldrush: Return to the West — Night 1", venue:"Rawhide Western Town", city:"Chandler", market:"phoenix", date:"2025-09-12", price:"$99–$250+", promoter:"Relentless Beats / Universatile / Global Dance", genre:"Festival (Multi-genre)", url:"https://goldrushfestaz.com", fest:true, source:"curated",
    lineup:[{ day:"Sep 12", artists:"Excision, Illenium b2b Zeds Dead (World Debut), Major Lazer Soundsystem, Crankdat, Dillon Francis, Disco Lines, Benny Benassi, Destructo, Drinkurwater, Getter (Resurrection Set), Kyle Watson, Wax Motif, Hi-Lo, Space Laces, Infekt, Kompany, LF System, Wilkinson, William Black, Rinzen, Roddy Lima, Showtek (Hardstyle), Sub Zero Project, Ninajirachi, Steller, Nikita, ChaseWest, Slamm b2b Dan Molinari, Versa b2b MVRDA, Dennett" }]},
  { artist:"Goldrush: Return to the West — Night 2", venue:"Rawhide Western Town", city:"Chandler", market:"phoenix", date:"2025-09-13", price:"$99–$250+", promoter:"Relentless Beats / Universatile / Global Dance", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Sep 13", artists:"Excision, Illenium b2b Zeds Dead, Major Lazer Soundsystem, Crankdat, Dillon Francis, Disco Lines, Benny Benassi, Destructo, Getter (Resurrection Set), Kyle Watson, Wax Motif, Space Laces, Kompany, Eliminate, Wilkinson, William Black + more" }]},
  // Svdden Death VOYD
  { artist:"Svdden Death VOYD: Forsaken Sands", venue:"Wild Horse Pass Festival Grounds", city:"Chandler", market:"phoenix", date:"2025-10-04", price:"$55–$110", promoter:"Relentless Beats / Aftershock", genre:"Riddim/Dubstep", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"Oct 4", artists:"Svdden Death (VOYD set) + supporting bass artists" }]},
  // Obsidian 2025
  { artist:"Obsidian 2025", venue:"Eastlake Park", city:"Phoenix", market:"phoenix", date:"2025-11-07", price:"$40–$85", promoter:"Relentless Beats / Body Language / Techno Snobs", genre:"Techno (Outdoor)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Nov 7", artists:"Multi-artist techno lineup — Body Language & Techno Snobs curated" }]},
  // DUSK 2025
  { artist:"DUSK Music Festival 2025", venue:"Jácome Plaza", city:"Tucson", market:"tucson", date:"2025-11-15", price:"$40–$80", promoter:"Relentless Beats / Rio Nuevo", genre:"Festival (Multi-genre)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Nov 15", artists:"Multi-genre electronic, indie & world music — Relentless Beats + Rio Nuevo curated" }]},
  // Decadence AZ 2025
  { artist:"Decadence Arizona 2025 — Night 1 (Portal of I11usions)", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-12-30", price:"$85–$250+", promoter:"Relentless Beats / Global Dance", genre:"Festival (Multi-genre)", url:"https://decadencearizona.com", fest:true, source:"curated",
    lineup:[{ day:"Dec 30", artists:"Adventure Club (Throwback Set), Ben Sterling, Brunello b2b KinAhau, Darren Styles, Hamdi, Hayden James, Kai Wachi b2b Sullivan King, Knock2, Max Styler, Meduza, Omri., Sammy Virji, Sara Landry, Whethan, Zedd, DMTRI, Gio Lucca, Stevie Nova" }]},
  { artist:"Decadence Arizona 2025 — Night 2 (NYE)", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2025-12-31", price:"$85–$250+", promoter:"Relentless Beats / Global Dance", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated",
    lineup:[{ day:"Dec 31", artists:"GRiZ (NYE Countdown Set), Chase & Status, Fisher, Green Velvet, Kaskade, Ky William, Level Up, Mike Posner, Odd Mob, Pedroz, PHRVA, Prunk, SG Lewis, Subtronics, Svdden Death presents VOYD, Tape B, Wax Motif (After Dark Set), Wakyin, Carrie Keller, DeathBeat, Michael Hooker" }]},
  // Walter WhereHouse — past
  { artist:"Kruder & Dorfmeister", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-09-29", price:"$30–$55", promoter:"Walter Where?House", genre:"Trip-Hop/Downtempo", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Bob Moses", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2024-05-04", price:"$25–$45", promoter:"Walter Where?House", genre:"Indie Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Miss Monique", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2025-02-21", price:"$25–$40", promoter:"Walter Where?House", genre:"Melodic Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  // Walter WhereHouse — upcoming
  { artist:"OMNOM", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-03", price:"TBA", promoter:"Walter Where?House", genre:"House/Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated" },
  { artist:"Anfisa Letyago + Disco Zombie + Mâ (AZ)", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-04", price:"TBA", promoter:"Walter Where?House", genre:"Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 4", artists:"Anfisa Letyago, Disco Zombie, Mâ (AZ)" }]},
  { artist:"OMRI. + CeCe", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-10", price:"TBA", promoter:"Walter Where?House", genre:"Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 10", artists:"OMRI., CeCe" }]},
  { artist:"Carl Craig + CD-6", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-11", price:"TBA", promoter:"Walter Where?House", genre:"Techno/Detroit", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 11", artists:"Carl Craig, CD-6" }]},
  { artist:"Kaleena Zanders + Eliza Rose + DJ Freedom", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-17", price:"TBA", promoter:"Walter Where?House", genre:"House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 17", artists:"Kaleena Zanders, Eliza Rose, DJ Freedom" }]},
  { artist:"Adam Ten + Riche + Amir Hakak", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-24", price:"$20–$35", promoter:"Walter Where?House / Independent", genre:"Melodic Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 24", artists:"Adam Ten, Riche, Amir Hakak" }]},
  { artist:"Gio Lucca + Baggins", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-04-25", price:"TBA", promoter:"Walter Where?House", genre:"House/Tech House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"Apr 25", artists:"Gio Lucca, Baggins" }]},
  { artist:"The Botanist + Rafael + Valerie Stoss", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-01", price:"TBA", promoter:"Walter Where?House", genre:"Organic House", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"May 1", artists:"The Botanist, Rafael, Valerie Stoss" }]},
  { artist:"N2N + ero808", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-09", price:"TBA", promoter:"Walter Where?House", genre:"House/Electronic", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"May 9", artists:"N2N, ero808" }]},
  { artist:"Effy + Mall Grab + Alix Rico", venue:"Walter Where?House", city:"Phoenix", market:"phoenix", date:"2026-05-15", price:"TBA", promoter:"Walter Where?House", genre:"Lo-fi House/Techno", url:"https://walterwherehouse.com", wwh:true, source:"curated", lineup:[{ day:"May 15", artists:"Effy, Mall Grab, Alix Rico" }]},
  // Breakaway 2026
  { artist:"Breakaway Arizona 2026 — Day 1", venue:"Sloan Park Festival Grounds", city:"Mesa", market:"phoenix", date:"2026-04-24", price:"$30–$200+", promoter:"Breakaway × Relentless Beats", genre:"Festival (Multi-genre)", url:"https://www.breakawayfestival.com/festival/arizona-2026", fest:true, source:"curated",
    lineup:[{ day:"Apr 24–25", artists:"Marshmello, Kygo, ISOxo, James Hype, Dr. Fresch, Effin, Grabbitz, Loud Luxury, Mersiv, Cassian, TRUTH, Angrybaby, Xandra, ALIGN, SHIMA, Steller, Jon Casey, MPH, Arthi, Disco Dom, Delato, Leesh, Livviep" }]},
  { artist:"Breakaway Arizona 2026 — Day 2", venue:"Sloan Park Festival Grounds", city:"Mesa", market:"phoenix", date:"2026-04-25", price:"$30–$200+", promoter:"Breakaway × Relentless Beats", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated" },
  // Crankdat
  { artist:"Crankdat", venue:"Rawhide Event Center", city:"Chandler", market:"phoenix", date:"2026-05-09", price:"$95+", promoter:"Relentless Beats / Aftershock", genre:"Bass/Dubstep", url:"https://relentlessbeats.com", source:"curated",
    lineup:[{ day:"May 9", artists:"Crankdat, Zingara, Zen Selekta, Casey Club" }]},
  // Goldrush Midnight Riders 2026
  { artist:"Goldrush: Midnight Riders 2026 — Night 1", venue:"Rawhide Western Town", city:"Chandler", market:"phoenix", date:"2026-09-11", price:"$227+", promoter:"Relentless Beats", genre:"Festival (Multi-genre)", url:"https://relentlessbeats.com", fest:true, source:"curated",
    lineup:[{ day:"Sep 11–12", artists:"Lineup TBA — follow @GoldrushFestAZ" }]},
  { artist:"Goldrush: Midnight Riders 2026 — Night 2", venue:"Rawhide Western Town", city:"Chandler", market:"phoenix", date:"2026-09-12", price:"$227+", promoter:"Relentless Beats", genre:"Festival (Multi-genre)", url:"", fest:true, source:"curated" },
  // Decadence AZ 2026
  { artist:"Decadence Arizona 2026", venue:"Phoenix Raceway", city:"Avondale", market:"phoenix", date:"2026-12-30", price:"TBA", promoter:"Relentless Beats", genre:"Festival (Multi-genre)", url:"https://decadencearizona.com", fest:true, source:"curated",
    lineup:[{ day:"Dec 30–31", artists:"Lineup TBA — follow @DecadenceArizona" }]},
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
