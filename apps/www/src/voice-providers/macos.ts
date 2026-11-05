import type { VoiceProvider } from "./types";
import { GITHUB_URL } from "../site";
import { VOICE_DOC, VOICE_MODELS_DOC } from "./shared";

export const macos: VoiceProvider = {
  slug: "macos",
  name: "macOS voices",
  does: "Speaks only",
  runs: "Your Mac",
  bestFor: "Running Matebot on a Mac with no voice key",
  title: "macOS voices for AI agents: built-in Mac speech with no API key",
  description:
    "Have AI agents read replies aloud and call you using the voices built into macOS, through the say command, with no API key or vendor. How it works in Matebot, what it can't do, and setup.",
  h1: "Use your Mac's built-in voices for AI agents",
  intro: [
    "Every Mac ships with dozens of text-to-speech voices, and Apple offers Enhanced and Premium versions that sound more natural. The `say` command turns text into speech with any of them, entirely on the machine, with no account and no API key.",
    "[Matebot](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. When the Matebot server runs directly on a Mac, it can use that Mac's voices, so bots speak without any voice provider.",
  ],
  scene: {
    bot: "Chief of Staff",
    color: "#3EC5A8",
    where: "Voice from the server's Mac",
    ask: "call me at 5 to go over the day",
    reply: "will do. i'll ring you at 5.",
    results: [
      { k: "Voice", v: "Zoe (Premium), built into macOS" },
      { k: "Key", v: "None needed" },
      { k: "Call", v: "4 min, transcript in chat" },
    ],
  },
  sections: [
    {
      heading: "What are macOS voices?",
      paragraphs: [
        "They are the system voices macOS uses for its own spoken content, such as reading selected text aloud. The `/usr/bin/say` command speaks with any installed voice and can save the result to an audio file instead of playing it, which is what Matebot does.",
        "More voices, and higher-quality Enhanced and Premium versions, download from Apple under **System Settings → Accessibility → Spoken Content → System voice → Manage Voices**.",
      ],
      image: true,
    },
    {
      heading: "What you can do with macOS voices in Matebot",
      paragraphs: [
        "The server renders each reply into a short audio clip with `say` and sends it to whoever is listening, so it plays on your phone or laptop like any other voice, not out of the server's speakers. The [voice and calls guide](/docs/voice-and-calls/) covers each feature.",
      ],
      bullets: [
        "Hear replies. Choose **Speak this reply** on a message, or turn on **Read replies aloud** in a bot's settings.",
        "Call a bot with **Call** at the top of the chat, or have a bot call you when you ask it to.",
        "Talk instead of typing, using on-device speech recognition. macOS voices don't transcribe, so your words are recognized by your browser, such as Chrome, or by the Matebot desktop app on a Mac.",
        "Choose any installed voice. Premium and Enhanced voices are listed first.",
      ],
    },
    {
      heading: "When to choose macOS voices",
      paragraphs: [
        "Choose them when you run Matebot on your own Mac and want bots to speak right away, with nothing to sign up for and nothing to install. Speech is made on the machine running Matebot, with no vendor involved, then sent to whichever device is listening.",
        "For voices that also transcribe, a [self-hosted speech server](/voice-providers/self-hosted/) keeps everything on your own hardware and works on Linux too. Hosted providers sound more natural and need a key: [ElevenLabs](/voice-providers/elevenlabs/) and [Fish Audio](/voice-providers/fish-audio/) clone voices, [OpenAI](/voice-providers/openai/) is the simplest, and [Cartesia](/voice-providers/cartesia/) is built for low latency. The [voice provider comparison](/voice-providers/) shows all six.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Matebot only offers it when its server process runs directly on macOS. A server in Docker, including Docker Desktop on a Mac and the desktop app's **This computer** install, runs Linux inside the container, so the option doesn't appear. Linux hosts don't list it either.",
        "It doesn't transcribe. Hold-to-talk and calls depend on speech recognition in your browser or the desktop app, and voice notes from messaging apps reach bots without a transcript.",
        "macOS voices sound less natural than the best hosted voices, and there's no voice cloning.",
        "The voices are whatever is installed on the server's Mac. A newly downloaded voice can take a few minutes to show up.",
        "On the mobile app, calls can use your phone's own voices if you pick a **Device voice** in the bot's settings. Otherwise replies use this provider.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "This is for someone running Matebot from source on their own Mac. The [self-hosting guide](/docs/self-host/) has the full instructions.",
      ],
      steps: [
        "On the Mac, clone Matebot, copy `.env.example` to `.env`, then run `pnpm install`, `pnpm sandbox:build` and `pnpm dev`. This runs the Matebot API directly on macOS.",
        "To use hold-to-talk and calls, set `PHONE_CALLS_ENABLED=true` in `.env` and restart.",
        "Optionally download Enhanced or Premium voices under **System Settings → Accessibility → Spoken Content → System voice → Manage Voices**.",
        "In Matebot, open **Settings → Voice** and set **Provider** to **Server (Mac)**. There's no key to enter.",
        "Pick a **Voice** and choose **Hear a sample**.",
      ],
    },
  ],
  image: {
    webp: "/graphics/voice-providers/macos.webp",
    avif: "/graphics/voice-providers/macos.avif",
    width: 1280,
    height: 720,
    alt: "Matebot showing an incoming call from the bot Chief, with Decline and Answer buttons beside the chat.",
    caption: "Chief calling from Matebot. With macOS voices, its side of the call is spoken by the server's Mac.",
  },
  faq: [
    {
      question: "Can an AI assistant use the macOS say command?",
      answer:
        "Yes. When Matebot's server runs on a Mac, it uses `say` to turn each reply into an audio clip in the voice you pick, with no API key.",
    },
    {
      question: "Why don't I see macOS voices in Matebot?",
      answer:
        "The option only appears when the Matebot server runs directly on macOS. In Docker, even on a Mac, the server runs on Linux and can't reach `say`. Use a self-hosted speech server there instead.",
    },
    {
      question: "Can macOS voices transcribe what I say?",
      answer:
        "No, they only speak. Matebot uses on-device speech recognition from your browser or the desktop app for your side, or you can switch to a provider that transcribes.",
    },
    {
      question: "How do I get better macOS voices?",
      answer:
        "Download Enhanced or Premium voices in **System Settings → Accessibility → Spoken Content → System voice → Manage Voices** on the server's Mac. Matebot lists them first.",
    },
  ],
  sources: [
    {
      label: "Apple, change the voice your Mac uses to speak text",
      href: "https://support.apple.com/guide/mac-help/mchlp2290/mac",
    },
    VOICE_DOC,
    VOICE_MODELS_DOC,
    { label: "Matebot, self-hosting", href: `${GITHUB_URL}/blob/main/docs/self-host.md` },
  ],
};
