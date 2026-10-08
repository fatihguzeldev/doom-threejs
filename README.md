# doom-threejs

a browser port of doom, written in typescript with three.js.

play at [doom.fatihguzel.dev](https://doom.fatihguzel.dev).

## wads

a wad contains the game's maps, textures, sprites, sounds and music. the engine reads that data to run the game.

the shareware wad is included and contains episode one. for the remaining episodes, load a doom.wad from your own copy of the game using the file picker. your file stays in the browser.

the engine is based on id software's original doom source and is licensed under gpl-2.0-only. the game data has a separate license.

## local

requires node.js 22.12 or newer.

```sh
npm install
npm run dev
```

`game/` contains the engine. `playground/` is the website that uses it.
