// Configuratie per streamingdienst voor generic.js.
//  hosts : domeinen waarop de dienst draait
//  names : merknamen die uit titels worden gehaald ("Kijk naar X | Disney+" -> "X")
//  detail: regex op het pad van een titelpagina (films/series)
//  card  : CSS-selector voor links naar een titel (kaartjes in rijen)
// LET OP: deze selectors zijn gebaseerd op de bekende URL-opbouw en nog NIET getest op een echt account.
globalThis.IMDbSites = [
  { id: "disney", label: "Disney+", hosts: ["disneyplus.com"], names: ["Disney+", "Disney Plus", "Disney"],
    detail: /\/(movies|series)\/|\/browse\/entity-/i,
    card: 'a[href*="/movies/"], a[href*="/series/"], a[href*="/browse/entity-"]' },
  { id: "videoland", label: "Videoland", hosts: ["videoland.com"], names: ["Videoland"],
    detail: /\/(films?|series?|programma'?s?|detail|title|titel)\//i,
    card: 'a[href*="/film"], a[href*="/serie"], a[href*="/programma"], a[href*="/detail"], a[href*="/title"]' },
  { id: "npo", label: "NPO Plus / NPO Start", hosts: ["npo.nl", "npostart.nl"], names: ["NPO Start", "NPO Plus", "NPO"],
    detail: /\/(serie|video|film|programma)\//i,
    card: 'a[href*="/serie/"], a[href*="/video/"], a[href*="/film/"]' },
  { id: "prime", label: "Prime Video", hosts: ["primevideo.com", "amazon.nl", "amazon.com", "amazon.de", "amazon.co.uk"], names: ["Prime Video", "Amazon"],
    detail: /\/detail\//i,
    card: 'a[href*="/detail/"]' },
  { id: "max", label: "Max / HBO Max", hosts: ["max.com", "hbomax.com"], names: ["Max", "HBO Max"],
    detail: /\/(movie|movies|show|shows|series)\//i,
    card: 'a[href*="/movie/"], a[href*="/movies/"], a[href*="/show/"], a[href*="/shows/"], a[href*="/series/"]' },
  { id: "appletv", label: "Apple TV", hosts: ["tv.apple.com"], names: ["Apple TV+", "Apple TV"],
    detail: /\/(movie|show)\//i,
    card: 'a[href*="/movie/"], a[href*="/show/"]' },
  { id: "skyshowtime", label: "SkyShowtime", hosts: ["skyshowtime.com"], names: ["SkyShowtime"],
    detail: /\/(movie|movies|series|show|shows)\//i,
    card: 'a[href*="/movie"], a[href*="/series"], a[href*="/show"]' },
  { id: "paramount", label: "Paramount+", hosts: ["paramountplus.com"], names: ["Paramount+", "Paramount Plus"],
    detail: /\/(movies|shows)\//i,
    card: 'a[href*="/movies/"], a[href*="/shows/"]' },
  { id: "hulu", label: "Hulu", hosts: ["hulu.com"], names: ["Hulu"],
    detail: /\/(movie|series)\//i,
    card: 'a[href*="/movie/"], a[href*="/series/"]' }
];
