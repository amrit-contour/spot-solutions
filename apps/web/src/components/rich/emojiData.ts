// A curated set of emoji for message boxes: what a comedy curator actually types, grouped, searchable by name.
// Each entry is "emoji name words". No dependency; the OS draws them.

export interface EmojiGroup {
  id: string;
  label: string;
  /** Shown on the category tab. */
  icon: string;
  items: { e: string; name: string }[];
}

const parse = (s: string) =>
  s
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [e, ...rest] = l.split(" ");
      return { e, name: rest.join(" ") };
    });

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    id: "show",
    label: "Show night",
    icon: "🎤",
    items: parse(`
🎤 microphone mic
🎙️ studio microphone podcast
🎭 performing arts theatre masks comedy drama
😂 laughing tears joy funny
🤣 rolling on the floor laughing rofl
😆 grinning squinting laugh
🎬 clapper board film
🎟️ ticket admission
🎫 ticket pass
📍 pin location venue map
🗺️ map
🧭 compass directions
🚗 car drive
🚕 taxi cab
🚇 metro subway train
🅿️ parking
⏰ alarm clock time
🕗 eight o'clock time
⏱️ stopwatch set length minutes
📅 calendar date
🗓️ calendar spiral week
🌙 moon night evening
🌃 night city
💡 light bulb idea
🔦 torch flashlight
🍻 beers cheers drinks
🍺 beer
🍸 cocktail drink
🥂 clinking glasses toast
📣 megaphone announce
📢 loudspeaker
🔔 bell
✅ check done confirmed yes
❌ cross no cancelled
⚠️ warning
🆕 new
🔥 fire hot
💯 hundred perfect
`),
  },
  {
    id: "faces",
    label: "Faces",
    icon: "🙂",
    items: parse(`
🙂 slight smile
😀 grinning
😃 smiley big eyes
😄 smile happy
😁 beaming grin
😅 sweat smile nervous
🙃 upside down
😉 wink
😊 blush happy
😍 heart eyes love
🥰 smiling hearts love
😘 kiss
😎 sunglasses cool
🤩 star struck wow
🥳 party face celebrate
😏 smirk
🤔 thinking hmm
🫡 salute
😬 grimace awkward
😴 sleeping tired
😮 surprised open mouth
😢 crying sad
😭 sobbing
😤 huffing proud
😡 angry
🥲 smile tear
🤗 hug
🙄 eye roll
😇 angel innocent
🤞 fingers crossed
`),
  },
  {
    id: "hands",
    label: "Hands",
    icon: "👏",
    items: parse(`
👏 clap applause
🙌 raised hands celebrate
🙏 pray thanks please
👍 thumbs up yes good
👎 thumbs down no
👌 ok perfect
✌️ peace victory
🤝 handshake deal
💪 flexed bicep strong
👋 wave hello bye
🫶 heart hands love
👀 eyes look
🤙 call me shaka
☝️ index up one
👉 point right
👇 point down
🤷 shrug
🙈 see no evil monkey
`),
  },
  {
    id: "party",
    label: "Celebrate",
    icon: "🎉",
    items: parse(`
🎉 party popper celebrate congratulations
🎊 confetti ball
🏆 trophy winner
🥇 gold medal first
⭐ star
🌟 glowing star
✨ sparkles
💫 dizzy star
🎁 gift present
🎈 balloon
🎂 birthday cake
🍾 champagne bottle pop
🚀 rocket
💥 boom collision
🎯 target bullseye
🌈 rainbow
`),
  },
  {
    id: "hearts",
    label: "Hearts",
    icon: "❤️",
    items: parse(`
❤️ red heart love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🖤 black heart
🤍 white heart
💖 sparkling heart
💕 two hearts
💔 broken heart
❤️‍🔥 heart on fire
`),
  },
  {
    id: "things",
    label: "Things",
    icon: "📱",
    items: parse(`
📱 phone mobile
💬 speech bubble chat message
📝 memo note write
📋 clipboard list
📌 pushpin pin
📎 paperclip attach
🔗 link
🔒 lock
🔑 key
💰 money bag
💸 money flying
🧾 receipt
📷 camera photo
🎥 video camera
🎧 headphones
🎵 music note
🎶 music notes
🔊 loud speaker volume
🔇 muted
⚡ lightning bolt
🔋 battery
📞 telephone call
📧 email
🪑 chair seat
🍕 pizza
☕ coffee
🍔 burger
🌮 taco
🍿 popcorn
`),
  },
  {
    id: "symbols",
    label: "Symbols",
    icon: "➡️",
    items: parse(`
➡️ arrow right
⬅️ arrow left
⬆️ arrow up
⬇️ arrow down
🔁 repeat
🔄 refresh
➕ plus add
➖ minus
❓ question
❗ exclamation
‼️ double exclamation
💤 zzz sleep
🔴 red circle
🟢 green circle
🟡 yellow circle
🔵 blue circle
🔺 red triangle
▶️ play
⏸️ pause
🆗 ok
🔜 soon
🔙 back
🆓 free
🅰️ a
🅱️ b
`),
  },
  {
    id: "nature",
    label: "Nature",
    icon: "🌴",
    items: parse(`
☀️ sun sunny
⛅ partly cloudy
🌧️ rain rainy
⛈️ thunderstorm
🌦️ sun behind rain
❄️ snow
🌴 palm tree
🌸 blossom flower
🌻 sunflower
🍀 four leaf clover luck
🐶 dog
🐱 cat
🦄 unicorn
🐒 monkey
🦜 parrot
🐢 turtle
`),
  },
];

const ALL = EMOJI_GROUPS.flatMap((g) => g.items);

/** Emoji whose name contains every word typed. */
export function searchEmoji(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return ALL.filter((x) => words.every((w) => x.name.split(" ").some((n) => n.startsWith(w)) || x.name.includes(w)));
}
