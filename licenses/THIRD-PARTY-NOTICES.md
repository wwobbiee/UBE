# Third-Party Notices
UBE is released under the ISC License (see `LICENSE`). This file lists third-party code distributed with the browser application in this repository, and the projects whose formats or source it references. It covers only this browser application.

## Code distributed with UBE

### StepMania DWI loader (interpretation logic)
`js/parsers/dwiParser.js` follows the DWI interpretation logic of StepMania's DWI loader: the step-symbol table, chord and 1/192-marker handling, subdivision markers and solo column mapping. The JavaScript is a separate implementation, but this notice is retained conservatively.

Source: https://github.com/stepmania/stepmania/blob/5_1-new/src/NotesLoaderDWI.cpp

Copyright (c) 2001-2004 Chris Danford, Glenn Maynard

See `licenses/stepmania-DWI-license.txt` for the permission notice.

### JSZip 3.10.2
`vendor/jszip.min.js` (unmodified upstream `dist/jszip.min.js`). Dual licensed under MIT or GPLv3; used under MIT.

Source: https://github.com/Stuk/jszip

See `vendor/jszip-LICENSE.txt`.

The JSZip bundle includes these libraries:

| Library | Version range (JSZip dependency) | License | Source | License text |
|---|---|---|---|---|
| pako | ~1.0.2 | MIT, plus the zlib license for code ported from zlib | https://github.com/nodeca/pako | `licenses/pako-LICENSE.txt`, `licenses/pako-zlib-LICENSE.txt` |
| lie | ~3.3.0 | MIT | https://github.com/calvinmetcalf/lie | `licenses/lie-LICENSE.md` |
| immediate (dependency of lie) | ~3.0.5 (via lie) | MIT | https://github.com/calvinmetcalf/immediate | `licenses/immediate-LICENSE.txt` |
| setimmediate | ^1.0.5 | MIT | https://github.com/YuzuJS/setImmediate | `licenses/setimmediate-LICENSE.txt` |

The license texts are copied from pako 1.0.11, lie 3.3.0, immediate 3.0.6 and setimmediate 1.0.5. These are the versions resolved by `package-lock.json`, and the texts match their upstream release tags. Update them if `vendor/jszip.min.js` is replaced.

### js-yaml 5.5.0
`vendor/js-yaml.mjs`. License: MIT.

Source: https://github.com/nodeca/js-yaml

See `vendor/js-yaml-LICENSE.txt`.

## Format references
The parsers and serializers are my own implementation of each format's file structure. No osu! or Quaver implementation code is used in the current browser application. The sources below were consulted for format structures, field names and values.

### osu!
The osu! documentation and source were referenced for the `.osu` beatmap format: sections, fields, hit-object and timing-point syntax.

- osu! file format: https://osu.ppy.sh/wiki/en/Client/File_formats/osu_(file_format)
- Source: https://github.com/ppy/osu, revision [db635ed6bdc1c9ec65f22fc0675824d92601cba9](https://github.com/ppy/osu/tree/db635ed6bdc1c9ec65f22fc0675824d92601cba9).

Copyright (c) ppy Pty Ltd. MIT; the license text is retained in `licenses/osu-MIT.txt` for reference.

### Quaver.API
The Quaver.API source was referenced for the `.qua` YAML properties and their order, numeric game-mode values and hit-object structures. These are used by `js/parsers/quaverParser.js` and `js/serializers/quaverSerializer.js`.

- Quaver format model: https://github.com/Quaver/Quaver.API/blob/master/Quaver.API/Maps/Qua.cs
- Quaver hit objects: https://github.com/Quaver/Quaver.API/blob/master/Quaver.API/Maps/Structures/HitObjectInfo.cs
- Source: https://github.com/Quaver/Quaver.API, revision [a921d561b2ece7f6bf3682446696c06c17b81649](https://github.com/Quaver/Quaver.API/tree/a921d561b2ece7f6bf3682446696c06c17b81649).

Copyright (c) Quaver. MPL-2.0; the license text is retained in `licenses/quaver-api-MPL-2.0.txt` for reference.

### BMS

- Original BMS format: https://bm98.yaneu.com/bm98/bmsformat.html

## Artwork
The UBE logo (`assets/ube-sm.png`) and favicon (`favicon.ico`) are original works by me, Robbie Yamashita, licensed under the project's ISC License 😃
