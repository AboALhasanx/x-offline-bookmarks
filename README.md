# X Bookmarks (Offline Bookmarks for X & Web)

An offline-first Android and iOS mobile application built with **Expo SDK 57** and **React Native** to save, organize, and view X (Twitter) posts, media, ancestor threads, and linked documentation 100% offline without requiring an active internet connection.

---

## Features

- **System Share Sheet Integration**: Share any post or article link directly from the X app or web browser to automatically queue and archive it offline.
- **Native X-Style Feed Cards**: Clean card layout styled after the official X client with author avatar, `@handle`, full post captions, and media previews.
- **Google Photos-Style Date Grouping**: Posts are automatically organized into chronological date sections (`Today`, `Yesterday`, `Weekday • Date`).
- **Multi-Media Carousel**: Supports posts with multiple photos, multiple MP4 videos, or mixed media with responsive scroll-snap swipe, slide counter badges (`1/N`), and paging indicators.
- **Resilient Offline In-App Browser**:
  - **Reader View**: Distraction-free typography with first-class support for technical documentation, code blocks (`<pre><code>`), tables, and images.
  - **Web View**: Inlined, self-contained CSS snapshots with script-stripping to prevent client-side framework crashes offline.
  - **Universal Headless Pre-Rendering**: Automatically pre-downloads client-side SPAs (ModelScope, Hugging Face, Next.js, VitePress, Docusaurus) by running the browser engine in the background to capture the fully-hydrated DOM.
- **Dark & Light Themes**: Integrated theme switcher with persistent storage and monochrome vector icons (`@expo/vector-icons`).
- **Animated Swipe-to-Delete**: Smooth gesture-driven deletion with custom animated vector trash icon and haptic thresholds.

---

## Tech Stack

- **Framework**: React Native 0.86.3, Expo SDK 57 (`~57.0.21`), TypeScript 6.0
- **Storage & Database**: `expo-sqlite`, `expo-file-system`
- **Rendering & Gestures**: `react-native-webview`, `react-native-gesture-handler`, `react-native-safe-area-context`
- **Native Integration**: `expo-share-intent`, `expo-intent-launcher`, `expo-clipboard`
- **Content Extraction**: `@mozilla/readability`, `linkedom`

---

## Getting Started

### Prerequisites

- Node.js 20+
- JDK 21 and Android SDK configured (for local Android builds)

### Installation

```bash
# Clone the repository
git clone https://github.com/AboALhasanx/x-offline-bookmarks.git
cd x-offline-bookmarks

# Install dependencies
npm install

# Typecheck
npm run typecheck
```

### Running the App

```bash
# Start Metro bundler
npx expo start --dev-client

# Run on Android device
npm run android
```

---

## License

This project is licensed under the [MIT License](LICENSE).
