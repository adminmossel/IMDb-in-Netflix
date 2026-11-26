# IMDb ratings in Netflix

A small Chrome extension that puts IMDb ratings straight onto Netflix. It also shows Rotten Tomatoes and Metascore, so you can get a quick idea of a film or series without opening three extra tabs.

I made this for my own Netflix browsing and kept adding the bits I wanted to see.

## What it does

- Adds an IMDb score to Netflix title cards, hover previews and title pages.
- Shows Rotten Tomatoes and Metascore when that information is available.
- Lets you hover over a rating to see more: poster, plot, genre, director, cast, awards and box office.
- Can show the vote count next to the IMDb score.
- Has a settings page where you can choose which scores to show, change badge size and enable debug information.
- Tries IMDb suggestions as well as OMDb title search, which helps with some alternative and translated titles.
- Caches results locally, so it doesn't request the same rating every time you scroll past a title.

## A look at it

<img src="https://github.com/user-attachments/assets/b8b64838-7d92-4358-9ad3-8c866d11fe6c" alt="IMDb rating badge" width="443">

<img src="https://github.com/user-attachments/assets/398d4321-1a12-4824-8e28-479e4962d98b" alt="Ratings shown in Netflix" width="755">

The badge has a small pop-in animation. While a rating is loading, it uses a shimmer placeholder. These are the actual CSS keyframes from [badge.css](imdb%20in%20netflix/badge.css):

```css
@keyframes imdbPop {
  from { opacity: 0; transform: scale(.85); }
  to   { opacity: 1; transform: none; }
}

@keyframes imdbShimmer {
  to { background-position: -200% 0; }
}
```

GitHub doesn't run the extension's CSS inside a README, so I've kept the screenshots as the visual preview and included the real animation code here.

## Install it

This is currently a Chrome extension (Manifest V3).

1. Download this repository or clone it:

   ```bash
   git clone https://github.com/adminmossel/IMDb-in-Netflix.git
   ```

2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the **imdb in netflix** folder inside the downloaded repository.
6. Open Netflix. The extension's settings page should open on first install.

## One-time setup: OMDb API key

The extension uses OMDb for the rating details, so you need your own API key.

1. Get a free key at [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx).
2. Choose the free plan and follow the activation link in the email.
3. Paste the key into the extension's settings page and click **Test and save**.

The free plan currently offers 1,000 requests per day. Found ratings are cached for 7 days; titles without a rating are cached for 12 hours. The settings page has a built-in connection and title diagnostic if something isn't showing up.

## Settings

You can switch these on or off:

- Rotten Tomatoes score
- Metascore
- Vote count
- Hover info card
- Debug mode

You can also choose a small, medium or large badge. The settings page is available in English and Dutch.

## A note on missing ratings

Sometimes a title won't have a match. Netflix can use a localized title, while the rating database may list a different title. The extension tries a few ways to match it, but it would rather show no rating than attach the wrong score to a film or series.

## Source

The extension code lives in [imdb in netflix/](imdb%20in%20netflix/). The main parts are:

- `content.js` — finds Netflix titles and places the badges.
- `background.js` — looks up ratings and manages the cache.
- `badge.js` and `badge.css` — build and style the badges and hover card.
- `options.html` and `options.js` — settings, API key setup and diagnostics.

Made by **adminmossel** in Meppel, The Netherlands.

[View the repository](https://github.com/adminmossel/IMDb-in-Netflix)
