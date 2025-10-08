# Raindrop Sync Plugin for Obsidian

Bidirectional sync between Raindrop.io bookmarks and Obsidian notes.

## Development

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Setup

```bash
# Install dependencies
npm install

# Start development mode (auto-rebuild on changes)
npm run dev

# Build for production
npm run build
```

### Project Structure

```
raindrop-sync/
├── main.ts           # Main plugin file
├── manifest.json     # Plugin metadata
├── package.json      # Dependencies
├── tsconfig.json     # TypeScript config
├── esbuild.config.mjs # Build configuration
└── README.md         # Documentation
```

## Features

### Phase 1 (MVP)

- ✓ Basic plugin structure
- ✓ Settings panel with API token
- ✓ Test connection functionality
- ✓ Status bar indicator
- ✓ Manual sync command
- ⏳ Bookmark import functionality
- ⏳ Note template creation

### Phase 2 (Automation)

- ⏳ Automatic sync scheduling
- ⏳ Bidirectional sync
- ⏳ Collection folder structure
- ⏳ Tag synchronization

## Configuration

1. Get your Raindrop API token from https://app.raindrop.io/settings/integrations
2. Open Obsidian Settings → Raindrop Sync
3. Paste your API token
4. Click "Test Connection" to verify
5. Configure your preferences
6. Run "Full Sync" from the command palette

## License

MIT
