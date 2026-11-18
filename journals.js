/*
 * Research Radar: journal configuration
 * --------------------------------------
 * Each field lists the journals Research Radar treats as "trusted" for that field.
 *   name  = shown in the field menu and the journal list
 *   short = shown on the small colored labels next to each paper
 * Journals are identified by their OpenAlex source IDs (S...). To add a journal, look it up at
 *   https://api.openalex.org/sources?search=JOURNAL%20NAME
 * and copy the "id" (the part after https://openalex.org/).
 *
 * "ssrn" is optional: SSRN papers are shown only when at least one author has published in the
 * journals listed here (SSRN itself has no quality screen). Delete the "ssrn" entry to turn SSRN off.
 *
 * "bluesky" is optional too: the "Shared on Bluesky" list. "trusted" sites are shown first with a
 * News / Research / Policy label (any .gov site counts as Policy); "blocked" sites (GIFs, video,
 * social media, link shorteners, shops) are ignored. Delete the "bluesky" entry to turn it off.
 *
 * Keep the object below valid JSON (double quotes, no trailing commas, no comments inside).
 */
window.RADAR_CONFIG = {
  "groups": [
    { "label": "Business", "fields": ["accounting", "finance"] },
    { "label": "Policy & economics (HKS)", "fields": ["policy", "public-econ", "applied-econ", "general-econ"] }
  ],
  "fields": {
    "accounting": {
      "name": "Accounting",
      "short": "Accounting",
      "journals": [
        { "name": "The Accounting Review", "ids": ["S160506855"] },
        { "name": "Journal of Accounting Research", "ids": ["S111116695"] },
        { "name": "Journal of Accounting and Economics", "ids": ["S62142384"] },
        { "name": "Contemporary Accounting Research", "ids": ["S65924262"] },
        { "name": "Review of Accounting Studies", "ids": ["S11853582"] },
        { "name": "Accounting, Organizations and Society", "ids": ["S198892436"] },
        { "name": "Journal of Accounting and Public Policy", "ids": ["S86762183"] }
      ]
    },
    "finance": {
      "name": "Finance",
      "short": "Finance",
      "journals": [
        { "name": "The Journal of Finance", "ids": ["S5353659"] },
        { "name": "Journal of Financial Economics", "ids": ["S149240962"] },
        { "name": "Review of Financial Studies", "ids": ["S170137484"] },
        { "name": "Journal of Financial and Quantitative Analysis", "ids": ["S193228710"] },
        { "name": "Review of Finance", "ids": ["S131117787", "S49857371"] },
        { "name": "Journal of Corporate Finance", "ids": ["S152282257"] }
      ]
    },
    "policy": {
      "name": "Public Policy & Administration",
      "short": "Public Policy",
      "journals": [
        { "name": "Journal of Policy Analysis and Management", "ids": ["S25370267"] },
        { "name": "Public Administration Review", "ids": ["S76877748"] },
        { "name": "Journal of Public Administration Research and Theory", "ids": ["S169433491"] },
        { "name": "Policy Studies Journal", "ids": ["S119514724"] },
        { "name": "Health Affairs", "ids": ["S4210185023"] },
        { "name": "World Development", "ids": ["S85457386"] }
      ]
    },
    "public-econ": {
      "name": "Public Economics",
      "short": "Public Econ",
      "journals": [
        { "name": "Journal of Public Economics", "ids": ["S199447588"] },
        { "name": "AEJ: Economic Policy", "ids": ["S158011328"] },
        { "name": "National Tax Journal", "ids": ["S116184629"] },
        { "name": "International Tax and Public Finance", "ids": ["S42192170"] }
      ]
    },
    "applied-econ": {
      "name": "Applied Economics (labor, health, development, environment)",
      "short": "Applied Econ",
      "journals": [
        { "name": "Journal of Labor Economics", "ids": ["S8557221"] },
        { "name": "Journal of Health Economics", "ids": ["S166621295"] },
        { "name": "Journal of Development Economics", "ids": ["S101209419"] },
        { "name": "Journal of Environmental Economics and Management", "ids": ["S200872515"] },
        { "name": "Journal of Urban Economics", "ids": ["S147692640"] }
      ]
    },
    "general-econ": {
      "name": "General-Interest Economics (AER, QJE, JPE, ...)",
      "short": "General Econ",
      "journals": [
        { "name": "American Economic Review", "ids": ["S23254222"] },
        { "name": "The Quarterly Journal of Economics", "ids": ["S203860005"] },
        { "name": "Journal of Political Economy", "ids": ["S95323914"] },
        { "name": "Econometrica", "ids": ["S95464858"] },
        { "name": "The Review of Economic Studies", "ids": ["S88935262"] },
        { "name": "AEJ: Applied Economics", "ids": ["S42893225"] }
      ]
    }
  },
  "workingPapers": {
    "name": "NBER Working Papers",
    "ids": ["S2809516038"]
  },
  "ssrn": {
    "name": "SSRN",
    "ids": ["S4210172589"]
  },
  "bluesky": {
    "days": 30,
    "trusted": {
      "News": ["nytimes.com", "wsj.com", "ft.com", "reuters.com", "apnews.com", "bloomberg.com", "economist.com", "washingtonpost.com", "theguardian.com", "politico.com", "politico.eu", "axios.com", "npr.org", "bbc.com", "bbc.co.uk", "cnbc.com", "cnn.com", "nbcnews.com", "cbsnews.com", "usatoday.com", "theatlantic.com", "propublica.org", "time.com", "fortune.com", "businessinsider.com", "marketwatch.com", "barrons.com", "fastcompany.com", "vox.com", "latimes.com", "bostonglobe.com", "semafor.com", "wired.com", "arstechnica.com", "theverge.com", "statnews.com", "insideclimatenews.org", "grist.org", "canarymedia.com", "nationalobserver.com", "theconversation.com", "nature.com", "science.org"],
      "Research": ["doi.org", "ssrn.com", "nber.org", "arxiv.org", "sciencedirect.com", "springer.com", "wiley.com", "tandfonline.com", "jstor.org", "aeaweb.org", "academic.oup.com", "cambridge.org", "pnas.org", "journals.uchicago.edu", "pubsonline.informs.org", "osf.io", "edworkingpapers.com", "cepr.org", "scholar.harvard.edu"],
      "Policy": ["brookings.edu", "urban.org", "taxpolicycenter.org", "piie.com", "cbpp.org", "epi.org", "aei.org", "cato.org", "rand.org", "imf.org", "worldbank.org", "oecd.org", "bis.org", "rooseveltinstitute.org", "newamerica.org", "pewresearch.org", "kff.org", "cfr.org", "itep.org", "taxfoundation.org", "bruegel.org", "cgdev.org", "ilo.org", "un.org", "europa.eu", "hks.harvard.edu", "hbs.edu"]
    },
    "blocked": ["youtube.com", "youtu.be", "klipy.com", "tenor.com", "giphy.com", "imgur.com", "spotify.com", "tiktok.com", "instagram.com", "x.com", "twitter.com", "facebook.com", "threads.net", "linkedin.com", "lnkd.in", "bit.ly", "buff.ly", "ow.ly", "tinyurl.com", "pnp.games", "twitch.tv", "discord.gg", "t.me", "patreon.com", "ko-fi.com", "gofundme.com", "amazon.com", "etsy.com", "apps.apple.com", "play.google.com", "bsky.app"]
  },
  "samples": [
    { "label": "AI & the workforce", "topic": "artificial intelligence workforce", "field": "accounting", "months": 24, "file": "samples/ai-workforce.json" },
    { "label": "Climate risk", "topic": "climate risk", "field": "finance", "months": 12, "file": "samples/climate-risk.json" },
    { "label": "Tax evasion", "topic": "tax evasion", "field": "public-econ", "months": 12, "file": "samples/tax-evasion.json" },
    { "label": "Administrative burden", "topic": "administrative burden", "field": "policy", "months": 12, "file": "samples/administrative-burden.json" }
  ]
};
