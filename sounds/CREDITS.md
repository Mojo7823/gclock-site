# Sound credits

Every sound here is a real field recording from [Freesound](https://freesound.org), released by its
recordist under **CC0 1.0** (public domain dedication,
<https://creativecommons.org/publicdomain/zero/1.0/>), except the frogs (frog-1..4.mp3): **CC BY 4.0**
(<https://creativecommons.org/licenses/by/4.0/>), "frogs in ditch 220517_0351.flac" by klankbeeld, cut and
changed as noted below. CC0 needs no attribution; we credit those recordists anyway, with thanks. The same list
is shown in the site's (i) panel (`SOUND_CREDITS` in `src/audio.js`).

Changes for every file: cut from the Freesound preview, filtered as noted, levelled, re-encoded as MP3
(96 kbps stereo / 64 kbps mono, 44.1 kHz). Loops are looped seamlessly (the tail crossfaded into the head;
they carry 0.25 s of wrap-around at both ends); bird calls and frog croaks are single calls, phrases or bouts
cut out, high-passed, faded and made mono. Rebuild with `tools/sounds/make.py` (Blender, headless).

| file | sound | recordist | source | what we changed |
|---|---|---|---|---|
| bird-dove-1..3.mp3 | mourning_dove _2017-06-06.wav | nathankwright | <https://freesound.org/people/nathankwright/sounds/456930/> | three songs (0:28, 0:39, 0:54), high-passed 250 Hz |
| bird-greattit-1.mp3 | 20260318_05h05 Albi - Great tit | Sadiquecat | <https://freesound.org/people/Sadiquecat/sounds/849589/> | one phrase (0:01), high-passed 1.5 kHz |
| bird-greattit-2..3.mp3 | Great tit | roelofmellema | <https://freesound.org/people/roelofmellema/sounds/790795/> | two phrases (0:06, 0:16), high-passed 1.5 kHz |
| bird-bluetit-1..3.mp3 | BlueTit | DistinctlyAverage | <https://freesound.org/people/DistinctlyAverage/sounds/872964/> | three calls (0:00, 0:03, 0:07), high-passed 1.5 kHz |
| bird-robin-1..2.mp3 | Robin singing | naturenotesuk | <https://freesound.org/people/naturenotesuk/sounds/418425/> | two phrases (0:10, 0:27), high-passed 1.5 kHz |
| bird-robin-3.mp3 | robin song | Andrew.soundscape | <https://freesound.org/people/Andrew.soundscape/sounds/671058/> | one phrase (0:19), high-passed 1.5 kHz |
| bird-robin-4.mp3 | Robin.wav | BeeProductive | <https://freesound.org/people/BeeProductive/sounds/372219/> | one phrase (0:13), high-passed 1.5 kHz |
| bird-blackbird-1..3.mp3 | Blackbird (isolated) | richwise | <https://freesound.org/people/richwise/sounds/811988/> | three phrases (0:04, 0:14, 0:33), high-passed 1 kHz |
| bird-blackbird-4.mp3 | Blackbird  Song | Sacha.Julien | <https://freesound.org/people/Sacha.Julien/sounds/725046/> | one phrase (0:42), high-passed 1 kHz |
| bird-thrush-1..3.mp3 | Song Thrush | richwise | <https://freesound.org/people/richwise/sounds/785669/> | three phrases (0:25, 0:34, 0:42), high-passed 1 kHz |
| bird-wren-1..3.mp3 | 110714_wren.wav | Andy_Gardner | <https://freesound.org/people/Andy_Gardner/sounds/125423/> | three songs (0:01, 0:13, 0:36), high-passed 1.5 kHz |
| bird-chaffinch-1..3.mp3 | Madeiran Chaffinch Song | Sacha.Julien | <https://freesound.org/people/Sacha.Julien/sounds/725195/> | three songs (0:02, 0:08, 0:20), high-passed 1.5 kHz |
| bird-crow-1.mp3 | Kraehenruf.mp3 | cfrooos | <https://freesound.org/people/cfrooos/sounds/181088/> | one caw series (0:10), high-passed 300 Hz |
| bird-crow-2.mp3 | Winter crow March 11 2025 | kvgarlic | <https://freesound.org/people/kvgarlic/sounds/792274/> | one caw series (0:08), high-passed 300 Hz |
| crickets.mp3 | AMB_Rural_Summer_Night.wav | AnthonyRamirez | <https://freesound.org/people/AnthonyRamirez/sounds/425425/> | 0:03-0:53, high-passed 400 Hz, looped, levelled |
| cricket-1.mp3 | loud-cricket2.aif | alienistcog | <https://freesound.org/people/alienistcog/sounds/124424/> | 0:01-0:13, high-passed 2 kHz, looped, levelled, mono |
| cricket-2.mp3 | 200906 Cricket, single close loud, PEC pm.flac | TRP | <https://freesound.org/people/TRP/sounds/568820/> | 0:39-0:59, high-passed 2 kHz, looped, levelled, mono |
| cricket-3.mp3 | Single Cricket Chirping, Close Perspective 03 | HECKFRICKER | <https://freesound.org/people/HECKFRICKER/sounds/753280/> | 0:40-0:58, high-passed 2 kHz, looped, levelled, mono |
| wind-calm.mp3 | Soft wind shaking the grass and a tree, muffled wind sometimes, slight insect noises, road hum very far away | felix.blume | <https://freesound.org/people/felix.blume/sounds/653942/> | 4:04-5:54, high-passed 120 Hz, looped, levelled |
| wind-strong.mp3 | Strong Wind Blowing Through Trees | HECKFRICKER | <https://freesound.org/people/HECKFRICKER/sounds/646549/> | 1:50-2:50, high-passed 120 Hz, looped, levelled |
| rain-light.mp3 | Rain light 2 (rural) | jmbphilmes | <https://freesound.org/people/jmbphilmes/sounds/200273/> | 0:03-1:03, high-passed 200 Hz, looped, levelled, mono |
| rain-heavy.mp3 | Rain heavy 2 (rural) | jmbphilmes | <https://freesound.org/people/jmbphilmes/sounds/200272/> | 0:02-0:38, high-passed 200 Hz, looped, levelled, mono |
| rain-ground.mp3 | puddleinwoods.aiff | klangfabrik | <https://freesound.org/people/klangfabrik/sounds/157161/> | 1:47-2:37, high-passed 250 Hz, looped, levelled |
| river.mp3 | Water stream calmed 3 | frederic.font | <https://freesound.org/people/frederic.font/sounds/168897/> | 0:20-1:20, high-passed 80 Hz, looped, levelled |
| frog-1..4.mp3 | frogs in ditch 220517_0351.flac (**CC BY 4.0**) | klankbeeld | <https://freesound.org/people/klankbeeld/sounds/634459/> | four croak bouts of edible frogs (0:51, 1:13, 1:46, 1:52), high-passed 300 Hz, faded, levelled, mono |
| bees.mp3 | Bees gallore - garden hedge full of bees | myrinvp | <https://freesound.org/people/myrinvp/sounds/859809/> | 0:23-1:09, high-passed 150 Hz, looped, levelled, mono |
| thunder-near-1.mp3 | 200817 Thunder, pretty close crack 4pm.flac | TRP | <https://freesound.org/people/TRP/sounds/567945/> | trimmed (0:02-0:15, from the crack), faded out, levelled |
| thunder-near-2.mp3 | Thunderclap | Fission9 | <https://freesound.org/people/Fission9/sounds/534023/> | trimmed (0:01-0:12, from the crack), faded out, levelled |
| thunder-mid.mp3 | 230724 Thunder, close crack light rain, mixpreroof, Toronto 5pm | TRP | <https://freesound.org/people/TRP/sounds/717909/> | trimmed (0:03-0:24), faded out, levelled |
| thunder-far-1.mp3 | Distant rumbles | richwise | <https://freesound.org/people/richwise/sounds/584946/> | one rumble (0:56-1:12), low-passed 9 kHz, faded out, levelled |
| thunder-far-2.mp3 | Distant rumbles | richwise | <https://freesound.org/people/richwise/sounds/584946/> | one rumble (0:37-0:53), low-passed 9 kHz, faded out, levelled |
| alarm-rooster.mp3 | Rooster crows | jsbarrett | <https://freesound.org/people/jsbarrett/sounds/200334/> | two crows (0:00-0:07), high-passed 250 Hz, faded out, levelled, mono (the alarm: `ALARM_CREDITS` in `src/alarm.js`) |
