import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFolder,
  TFile,
  normalizePath,
  requestUrl,
  FuzzySuggestModal,
  TextComponent,
} from "obsidian";

interface RaindropSyncSettings {
  apiToken: string;
  resourceFolder: string;
  autoSync: boolean;
  syncInterval: number;
  useCollectionFolders: boolean;
  bidirectionalSync: boolean;
  testMode: boolean;
  testModeLimit: number;
}

interface RaindropBookmark {
  _id: number;
  title: string;
  link: string;
  excerpt: string;
  note: string;
  type: string;
  cover: string;
  tags: string[];
  created: string;
  lastUpdate: string;
  collection: {
    $id: number;
    title: string;
  };
  domain: string;
}

interface RaindropCollection {
  _id: number;
  title: string;
  count: number;
  parent?: {
    $id: number;
  };
}

interface RaindropApiResponse {
  result: boolean;
  items: RaindropBookmark[];
  count: number;
}

interface RaindropCollectionsResponse {
  result: boolean;
  items: RaindropCollection[];
}

const DEFAULT_SETTINGS: RaindropSyncSettings = {
  apiToken: "",
  resourceFolder: "Resources",
  autoSync: false,
  syncInterval: 30,
  useCollectionFolders: true,
  bidirectionalSync: true,
  testMode: false,
  testModeLimit: 5,
};

export default class RaindropSyncPlugin extends Plugin {
  settings: RaindropSyncSettings;
  statusBarItem: HTMLElement;
  lastSyncTime: Date | null = null;

  async onload() {
    console.log("Loading Raindrop Sync plugin");

    await this.loadSettings();

    // Add status bar item
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();

    // Add ribbon icon
    this.addRibbonIcon("sync", "Sync Raindrop bookmarks", async () => {
      await this.syncBookmarks();
    });

    // Add commands
    this.addCommand({
      id: "raindrop-full-sync",
      name: "Full Sync",
      callback: async () => {
        await this.syncBookmarks();
      },
    });

    this.addCommand({
      id: "raindrop-test-connection",
      name: "Test Connection",
      callback: async () => {
        await this.testConnection();
      },
    });

    this.addCommand({
      id: "raindrop-undo-sync",
      name: "Undo Last Sync (Delete All Synced Files)",
      callback: async () => {
        await this.undoSync();
      },
    });

    this.addCommand({
      id: "raindrop-debug-collections",
      name: "Debug: Show Collections & Sample Bookmarks",
      callback: async () => {
        await this.debugCollections();
      },
    });

    // Add settings tab
    this.addSettingTab(new RaindropSyncSettingTab(this.app, this));
  }

  onunload() {
    console.log("Unloading Raindrop Sync plugin");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  updateStatusBar() {
    if (this.lastSyncTime) {
      const timeString = this.lastSyncTime.toLocaleTimeString();
      this.statusBarItem.setText(`Last sync: ${timeString}`);
    } else {
      this.statusBarItem.setText("Raindrop: Not synced");
    }
  }

  async testConnection(): Promise<boolean> {
    if (!this.settings.apiToken) {
      new Notice("Please set your Raindrop API token in settings");
      return false;
    }

    try {
      const response = await requestUrl({
        url: "https://api.raindrop.io/rest/v1/user",
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
        },
      });

      if (response.status === 200) {
        const data = response.json;
        new Notice(`✓ Connected as ${data.user.fullName || data.user.email}`);
        return true;
      } else {
        new Notice("✗ Connection failed. Check your API token.");
        return false;
      }
    } catch (error) {
      console.error("Connection test failed:", error);
      new Notice("✗ Connection error. Check console for details.");
      return false;
    }
  }

  async debugCollections(): Promise<void> {
    if (!this.settings.apiToken) {
      new Notice("Please set your Raindrop API token in settings");
      return;
    }

    new Notice("Fetching debug data...");

    try {
      // Fetch collections
      const collections = await this.fetchCollections();
      console.log("========================================");
      console.log("📚 COLLECTIONS:");
      console.log("========================================");
      collections.forEach((col) => {
        console.log(
          `  - ID: ${col._id}, Title: "${col.title}", Count: ${col.count}`
        );
      });

      // Fetch first 5 bookmarks
      const response = await requestUrl({
        url: `https://api.raindrop.io/rest/v1/raindrops/0?perpage=5`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
        },
      });

      const data: RaindropApiResponse = response.json;
      console.log("========================================");
      console.log("🔖 SAMPLE BOOKMARKS (first 5):");
      console.log("========================================");
      data.items.forEach((bookmark, index) => {
        console.log(`\n[${index + 1}] ${bookmark.title}`);
        console.log(`    Collection ID: ${bookmark.collection?.$id}`);
        console.log(`    Collection Title: "${bookmark.collection?.title}"`);
        console.log(`    Has collection?: ${!!bookmark.collection}`);
        console.log(`    Raw collection:`, bookmark.collection);
      });
      console.log("========================================");
      console.log("⚙️ CURRENT SETTINGS:");
      console.log("========================================");
      console.log(
        `  useCollectionFolders: ${this.settings.useCollectionFolders}`
      );
      console.log(`  resourceFolder: ${this.settings.resourceFolder}`);
      console.log(`  testMode: ${this.settings.testMode}`);
      console.log("========================================");

      new Notice("✓ Check console for debug output (Cmd+Option+I)");
    } catch (error) {
      console.error("Debug failed:", error);
      new Notice("✗ Debug failed. Check console.");
    }
  }

  async undoSync(): Promise<void> {
    new Notice("Searching for Raindrop synced files...");

    try {
      const folder = this.app.vault.getAbstractFileByPath(
        normalizePath(this.settings.resourceFolder)
      );

      if (!(folder instanceof TFolder)) {
        new Notice("Resource folder not found");
        return;
      }

      const files = this.getAllFilesInFolder(folder);
      let deletedCount = 0;

      for (const file of files) {
        if (file.extension !== "md") continue;

        try {
          // Check if file still exists before reading
          const fileExists = this.app.vault.getAbstractFileByPath(file.path);
          if (!fileExists) {
            console.warn(`File no longer exists, skipping: ${file.path}`);
            continue;
          }

          const content = await this.app.vault.read(file);
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

          if (!frontmatterMatch) continue;

          const frontmatter = frontmatterMatch[1];

          // Check if this is a raindrop-synced file
          if (frontmatter.includes("type: raindrop-bookmark")) {
            await this.app.vault.delete(file);
            deletedCount++;
          }
        } catch (error: any) {
          console.warn(`Skipping file ${file.path}: ${error.message || error}`);
          continue; // Continue with next file
        }
      }

      // Clean up empty folders
      await this.cleanupEmptyFolders(folder);

      new Notice(
        `✓ Deleted ${deletedCount} synced files and cleaned up empty folders`
      );
      this.lastSyncTime = null;
      this.updateStatusBar();
    } catch (error) {
      console.error("Undo sync failed:", error);
      new Notice("✗ Failed to undo sync. Check console for details.");
    }
  }

  async cleanupEmptyFolders(folder: TFolder): Promise<void> {
    // Create a copy of children array to avoid issues when deleting
    const children = [...folder.children];

    for (const child of children) {
      if (child instanceof TFolder) {
        // Recursively clean subfolders first
        await this.cleanupEmptyFolders(child);

        // Check again if folder is empty (after recursive cleanup)
        // Need to get fresh reference
        const currentFolder = this.app.vault.getAbstractFileByPath(child.path);
        if (
          currentFolder instanceof TFolder &&
          currentFolder.children.length === 0
        ) {
          try {
            await this.app.vault.delete(currentFolder);
            console.log(`Deleted empty folder: ${currentFolder.path}`);
          } catch (error) {
            console.error(
              `Failed to delete empty folder ${currentFolder.path}:`,
              error
            );
          }
        }
      }
    }
  }

  async cleanupDeletedBookmarks(
    syncedRaindropIds: Set<number>,
    activeCollections: Map<number, RaindropCollection>
  ): Promise<void> {
    try {
      const folder = this.app.vault.getAbstractFileByPath(
        normalizePath(this.settings.resourceFolder)
      );

      if (!(folder instanceof TFolder)) {
        return;
      }

      // Find all files and check if their bookmarks still exist in Raindrop
      const files = this.getAllFilesInFolder(folder);
      let deletedCount = 0;
      let movedToUnsortedCount = 0;

      for (const file of files) {
        if (file.extension !== "md") continue;

        try {
          // Check if file still exists before reading
          const fileExists = this.app.vault.getAbstractFileByPath(file.path);
          if (!fileExists) {
            console.warn(`File no longer exists, skipping: ${file.path}`);
            continue;
          }

          const content = await this.app.vault.read(file);
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

          if (!frontmatterMatch) continue;

          const frontmatter = frontmatterMatch[1];
          const raindropIdMatch = frontmatter.match(/raindrop_id:\s*(\d+)/);

          if (!raindropIdMatch) continue;

          const raindropId = parseInt(raindropIdMatch[1]);

          // Check if this bookmark still exists in Raindrop
          if (!syncedRaindropIds.has(raindropId)) {
            // Bookmark was deleted from Raindrop
            // Option 1: Delete the file (current behavior)
            await this.app.vault.delete(file);
            deletedCount++;
            console.log(
              `Deleted file for bookmark removed from Raindrop: ${file.path} (ID: ${raindropId})`
            );
          } else {
            // Bookmark exists, but check if collection changed
            // This will be handled by createOrUpdateNote which moves files to correct locations
            // So we don't need to do anything here
          }
        } catch (error: any) {
          console.warn(`Skipping file ${file.path}: ${error.message || error}`);
          continue; // Continue with next file
        }
      }

      // Clean up any empty folders left behind
      await this.cleanupEmptyFolders(folder);

      if (deletedCount > 0) {
        console.log(
          `🗑️ Cleaned up ${deletedCount} file(s) for bookmarks deleted from Raindrop`
        );
      }
    } catch (error) {
      console.error("Failed to cleanup deleted bookmarks:", error);
    }
  }

  async updateSyncStatusNote(
    totalBookmarks: number,
    createdCount: number,
    updatedCount: number,
    syncedBackCount: number,
    skippedCount: number = 0,
    failedCount: number = 0
  ): Promise<void> {
    try {
      const statusNotePath = normalizePath(
        `${this.settings.resourceFolder}/Raindrop Sync Status.md`
      );

      const now = new Date();
      const dateString = now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const timeString = now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      const content = `---
type: raindrop-sync-status
last_sync: ${now.toISOString()}
---

# 🔄 Raindrop Sync Status

## Last Full Sync

**Date:** ${dateString}  
**Time:** ${timeString}

## Sync Statistics

- **Total Bookmarks:** ${totalBookmarks}
- **Created:** ${createdCount}
- **Updated:** ${updatedCount}
- **Skipped:** ${skippedCount}
${failedCount > 0 ? `- **Failed:** ${failedCount} ⚠️` : ""}
${
  this.settings.bidirectionalSync
    ? `- **Synced Back to Raindrop:** ${syncedBackCount}`
    : ""
}

## Settings

- **Folder:** ${this.settings.resourceFolder}
- **Use Collection Folders:** ${
        this.settings.useCollectionFolders ? "Yes" : "No"
      }
- **Bidirectional Sync:** ${this.settings.bidirectionalSync ? "Yes" : "No"}
- **Test Mode:** ${
        this.settings.testMode
          ? `Yes (${this.settings.testModeLimit} items)`
          : "No"
      }

---

*This note is automatically updated after each sync.*
`;

      const existingFile = this.app.vault.getAbstractFileByPath(statusNotePath);

      if (existingFile instanceof TFile) {
        await this.app.vault.modify(existingFile, content);
      } else {
        await this.app.vault.create(statusNotePath, content);
      }
    } catch (error) {
      console.error("Failed to update sync status note:", error);
      // Don't throw - this shouldn't break the sync
    }
  }

  async syncBookmarks() {
    if (!this.settings.apiToken) {
      new Notice("Please set your Raindrop API token in settings");
      return;
    }

    const syncMessage = this.settings.testMode
      ? `Starting sync (Test Mode: ${this.settings.testModeLimit} items)...`
      : "Starting sync...";
    new Notice(syncMessage);

    try {
      // Bidirectional sync: Obsidian → Raindrop (FIRST to preserve local changes)
      let syncedBackCount = 0;
      if (this.settings.bidirectionalSync) {
        this.statusBarItem.setText("🔄 Syncing to Raindrop...");
        syncedBackCount = await this.syncNotesToRaindrop();
      }

      // Fetch collections if using collection folders
      let collections: Map<number, RaindropCollection> = new Map();
      if (this.settings.useCollectionFolders) {
        this.statusBarItem.setText("🔄 Fetching collections...");
        const collectionsArray = await this.fetchCollections();
        collectionsArray.forEach((col) => collections.set(col._id, col));

        // Debug: Show collection hierarchy
        console.log("🗂️ COLLECTION HIERARCHY:");
        collectionsArray.forEach((col) => {
          const parentInfo = col.parent
            ? ` → Parent ID: ${col.parent.$id}`
            : " (Root)";
          console.log(`  ${col.title}${parentInfo}`);
        });
      }

      // Fetch all bookmarks
      this.statusBarItem.setText("🔄 Fetching bookmarks...");
      const bookmarks = await this.fetchAllBookmarks();
      const totalBookmarks = bookmarks.length;

      // Ensure base resource folder exists
      await this.ensureFolderExists(this.settings.resourceFolder);

      // Create notes for each bookmark (Raindrop → Obsidian)
      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;
      let processedCount = 0;
      const failedBookmarks: Array<{ id: number; title: string; error: string }> = [];

      for (const bookmark of bookmarks) {
        processedCount++;
        // Update status bar with progress
        this.statusBarItem.setText(
          `🔄 Syncing ${processedCount}/${totalBookmarks}...`
        );

        try {
          const result = await this.createOrUpdateNote(bookmark, collections);
          if (result === "created") createdCount++;
          else if (result === "updated") updatedCount++;
          else if (result === "skipped") skippedCount++;
        } catch (error: any) {
          failedCount++;
          const errorMessage = error?.message || String(error);
          failedBookmarks.push({
            id: bookmark._id,
            title: bookmark.title || "Untitled",
            error: errorMessage,
          });
          console.error(
            `Failed to sync bookmark ${bookmark._id} (${bookmark.title}):`,
            error
          );
          // Continue with next bookmark instead of stopping
        }
      }

      // Log failed bookmarks if any
      if (failedBookmarks.length > 0) {
        console.warn(
          `⚠️ ${failedBookmarks.length} bookmarks failed to sync:`,
          failedBookmarks
        );
      }

      // Clean up bookmarks that were deleted from Raindrop
      this.statusBarItem.setText("🔄 Cleaning up deleted bookmarks...");
      const syncedRaindropIds = new Set(bookmarks.map((b) => b._id));
      await this.cleanupDeletedBookmarks(syncedRaindropIds, collections);

      this.lastSyncTime = new Date();
      this.updateStatusBar();

      // Create/update sync status note
      await this.updateSyncStatusNote(
        totalBookmarks,
        createdCount,
        updatedCount,
        syncedBackCount,
        skippedCount,
        failedCount
      );

      let message = `✓ Sync completed! Created: ${createdCount}, Updated: ${updatedCount}`;
      if (skippedCount > 0) message += `, Skipped: ${skippedCount}`;
      if (failedCount > 0) message += `, Failed: ${failedCount}`;
      if (this.settings.bidirectionalSync) message += `, Synced back: ${syncedBackCount}`;

      new Notice(message);
      
      // Show warning if not all bookmarks were processed
      if (totalBookmarks !== createdCount + updatedCount + skippedCount + failedCount) {
        console.warn(
          `⚠️ Bookmark count mismatch: Total=${totalBookmarks}, Processed=${createdCount + updatedCount + skippedCount + failedCount}`
        );
      }
      
      // Show warning if failed bookmarks exist
      if (failedCount > 0) {
        new Notice(
          `⚠️ ${failedCount} bookmarks failed to sync. Check console for details.`,
          8000
        );
      }
    } catch (error) {
      console.error("Sync failed:", error);
      new Notice("✗ Sync failed. Check console for details.");
      this.updateStatusBar(); // Restore status bar
    }
  }

  async fetchCollections(): Promise<RaindropCollection[]> {
    try {
      const response = await requestUrl({
        url: "https://api.raindrop.io/rest/v1/collections",
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
        },
      });

      if (response.status !== 200) {
        throw new Error(`Failed to fetch collections: ${response.status}`);
      }

      const data: RaindropCollectionsResponse = response.json;

      // Debug: Check all collections for parent field
      console.log("🔍 Checking all collections for parent field:");
      data.items.forEach((col, index) => {
        const hasParentField = "parent" in col;
        const parentValue = (col as any).parent;
        if (parentValue !== null && parentValue !== undefined) {
          console.log(`  [${index}] ${col.title} → parent:`, parentValue);
        }
      });

      const withParents = data.items.filter((col) => {
        const hasParent = col.parent && col.parent.$id;
        return hasParent;
      });
      console.log(
        `📊 Collections with valid parents: ${withParents.length} out of ${data.items.length}`
      );

      return data.items;
    } catch (error) {
      console.error("Failed to fetch collections:", error);
      return [];
    }
  }

  async fetchAllBookmarks(): Promise<RaindropBookmark[]> {
    const allBookmarks: RaindropBookmark[] = [];
    let page = 0;
    const perPage = 50;
    let hasMore = true;
    let totalCountFromAPI: number | null = null;

    console.log("📥 Starting to fetch bookmarks from Raindrop API...");

    while (hasMore) {
      try {
        const response = await requestUrl({
          url: `https://api.raindrop.io/rest/v1/raindrops/0?perpage=${perPage}&page=${page}`,
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.settings.apiToken}`,
          },
        });

        if (response.status !== 200) {
          throw new Error(`API request failed: ${response.status}`);
        }

        const data: RaindropApiResponse = response.json;

        // Store total count from API (first page)
        if (totalCountFromAPI === null && data.count !== undefined) {
          totalCountFromAPI = data.count;
          console.log(`📊 Total bookmarks in Raindrop: ${totalCountFromAPI}`);
        }

        console.log(
          `📄 Page ${page + 1}: Fetched ${data.items.length} bookmarks (Total so far: ${allBookmarks.length + data.items.length})`
        );

        allBookmarks.push(...data.items);

        // Check test mode limit
        if (
          this.settings.testMode &&
          allBookmarks.length >= this.settings.testModeLimit
        ) {
          console.log(
            `🧪 Test mode: Limiting to ${this.settings.testModeLimit} bookmarks`
          );
          return allBookmarks.slice(0, this.settings.testModeLimit);
        }

        // Check if there are more pages
        // Continue if we got a full page, or if we haven't reached the total count yet
        hasMore = data.items.length === perPage;
        
        // Also check if we've fetched all bookmarks according to API count
        if (totalCountFromAPI !== null && allBookmarks.length >= totalCountFromAPI) {
          hasMore = false;
          console.log(
            `✓ Fetched all ${allBookmarks.length} bookmarks (API reported ${totalCountFromAPI})`
          );
        }

        page++;

        // Add a small delay to respect rate limits
        if (hasMore) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`❌ Error fetching page ${page}:`, error);
        throw error; // Re-throw to stop sync if API fails
      }
    }

    console.log(
      `✅ Finished fetching: ${allBookmarks.length} bookmarks total${
        totalCountFromAPI !== null
          ? ` (API reported ${totalCountFromAPI})`
          : ""
      }`
    );

    // Warn if count mismatch
    if (
      totalCountFromAPI !== null &&
      allBookmarks.length !== totalCountFromAPI
    ) {
      console.warn(
        `⚠️ Bookmark count mismatch: Fetched ${allBookmarks.length}, but API reported ${totalCountFromAPI}`
      );
    }

    return allBookmarks;
  }

  async syncNotesToRaindrop(): Promise<number> {
    let syncedCount = 0;

    try {
      // Find all raindrop bookmark notes
      const folder = this.app.vault.getAbstractFileByPath(
        normalizePath(this.settings.resourceFolder)
      );

      if (!(folder instanceof TFolder)) {
        return 0;
      }

      const files = this.getAllFilesInFolder(folder);
      let processedFiles = 0;
      const totalFiles = files.length;

      for (const file of files) {
        processedFiles++;

        if (file.extension !== "md") continue;

        // Update progress
        if (totalFiles > 10) {
          this.statusBarItem.setText(
            `🔄 Checking ${processedFiles}/${totalFiles} notes...`
          );
        }

        try {
          // Check if file still exists before reading
          const fileExists = this.app.vault.getAbstractFileByPath(file.path);
          if (!fileExists) {
            console.warn(`File no longer exists, skipping: ${file.path}`);
            continue;
          }

          const content = await this.app.vault.read(file);
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

          if (!frontmatterMatch) continue;

          const frontmatter = frontmatterMatch[1];
          const raindropIdMatch = frontmatter.match(/raindrop_id:\s*(\d+)/);
          const lastSyncedMatch = frontmatter.match(/last_synced:\s*(.+)/);

          if (!raindropIdMatch) continue;

          const raindropId = parseInt(raindropIdMatch[1]);
          const lastSynced = lastSyncedMatch
            ? new Date(lastSyncedMatch[1])
            : new Date(0);
          const fileModified = new Date(file.stat.mtime);

          // Only sync if file was modified after last sync
          if (fileModified <= lastSynced) continue;

          // Extract notes section (now at the end of file)
          const notesMatch = content.match(/## Notes\n+([\s\S]*?)$/);
          if (!notesMatch) continue;

          const notes = notesMatch[1].trim();

          // Skip if notes are empty or just whitespace
          if (!notes || notes.length === 0) continue;

          // Extract tags from frontmatter
          const tagsMatch = frontmatter.match(/tags:\n((?:  - .+\n?)*)/);
          let tags: string[] = [];
          if (tagsMatch) {
            tags = tagsMatch[1]
              .split("\n")
              .map((line) => line.replace(/^\s*-\s*/, "").trim())
              .filter((tag) => tag.length > 0)
              .map((tag) => this.convertTagToRaindropFormat(tag));
          }

          // Update Raindrop via API
          await this.updateRaindropNote(raindropId, notes, tags);

          // Update last_synced in frontmatter
          const newContent = content.replace(
            /last_synced:\s*.+/,
            `last_synced: ${new Date().toISOString()}`
          );
          await this.app.vault.modify(file, newContent);

          syncedCount++;

          // Rate limiting
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error: any) {
          console.warn(`Skipping file ${file.path}: ${error.message || error}`);
          continue; // Continue with next file instead of stopping
        }
      }
    } catch (error) {
      console.error("Failed to sync notes to Raindrop:", error);
    }

    return syncedCount;
  }

  getAllFilesInFolder(folder: TFolder): TFile[] {
    const files: TFile[] = [];

    for (const child of folder.children) {
      if (child instanceof TFile) {
        files.push(child);
      } else if (child instanceof TFolder) {
        files.push(...this.getAllFilesInFolder(child));
      }
    }

    return files;
  }

  async updateRaindropNote(
    raindropId: number,
    notes: string,
    tags?: string[]
  ): Promise<void> {
    try {
      const updateData: any = {
        note: notes,
      };

      if (tags && tags.length > 0) {
        updateData.tags = tags;
      }

      await requestUrl({
        url: `https://api.raindrop.io/rest/v1/raindrop/${raindropId}`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updateData),
      });
    } catch (error) {
      console.error(`Failed to update raindrop ${raindropId}:`, error);
      throw error;
    }
  }

  convertTagToRaindropFormat(tag: string): string {
    // Convert "ai-in-ux" to "AI in UX"
    return tag
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  getCollectionPath(
    collectionId: number,
    collections: Map<number, RaindropCollection>
  ): string {
    const pathParts: string[] = [];
    let currentId: number | undefined = collectionId;

    // Walk up the parent chain to build the full path
    while (currentId !== undefined) {
      const collection = collections.get(currentId);
      if (!collection) break;

      // Add current collection title to the path
      pathParts.unshift(this.sanitizeFileName(collection.title));

      // Move to parent
      currentId = collection.parent?.$id;
    }

    // Join all parts with /
    return pathParts.join("/");
  }

  async ensureFolderExists(folderPath: string): Promise<void> {
    const normalizedPath = normalizePath(folderPath);
    const folder = this.app.vault.getAbstractFileByPath(normalizedPath);

    if (!folder) {
      try {
        await this.app.vault.createFolder(normalizedPath);
      } catch (error: any) {
        // Ignore "already exists" errors - this can happen with race conditions
        if (!error.message?.includes("already exists")) {
          throw error;
        }
      }
    }
  }

  async createOrUpdateNote(
    bookmark: RaindropBookmark,
    collections: Map<number, RaindropCollection>
  ): Promise<"created" | "updated" | "skipped"> {
    // Determine folder path based on settings
    let folderPath = this.settings.resourceFolder;
    let collectionTitle = "Unsorted";

    // Look up collection title from the collections map using the collection ID
    if (bookmark.collection?.$id) {
      const collection = collections.get(bookmark.collection.$id);
      if (collection?.title) {
        collectionTitle = collection.title;
      }
    }

    if (this.settings.useCollectionFolders) {
      if (collectionTitle && collectionTitle !== "Unsorted") {
        // Build full nested path including parent groups
        const collectionPath = this.getCollectionPath(
          bookmark.collection.$id,
          collections
        );
        folderPath = `${this.settings.resourceFolder}/${collectionPath}`;
        console.log(`📁 "${bookmark.title}" → ${collectionPath}`);
      } else {
        // Use Unsorted folder
        folderPath = `${this.settings.resourceFolder}/Unsorted`;
      }

      // Ensure folder exists (creates all parent folders)
      await this.ensureFolderExists(folderPath);
    }

    // Sanitize filename and ensure uniqueness
    const baseFileName = this.sanitizeFileName(bookmark.title);
    const fileName = await this.ensureUniqueFileName(
      folderPath,
      baseFileName,
      bookmark._id
    );
    const filePath = normalizePath(`${folderPath}/${fileName}.md`);

    // Check if file exists elsewhere (moved to different collection)
    const existingFileInDifferentLocation = await this.findFileByRaindropId(
      bookmark._id
    );
    if (
      existingFileInDifferentLocation &&
      existingFileInDifferentLocation.path !== filePath
    ) {
      // Delete old file and create new one in correct location
      await this.app.vault.delete(existingFileInDifferentLocation);
    }

    // Generate note content
    const noteContent = this.generateNoteContent(bookmark, collectionTitle);

    // Check if file exists at target location
    const existingFile = this.app.vault.getAbstractFileByPath(filePath);

    if (existingFile instanceof TFile) {
      // Update existing file
      let currentContent: string;
      try {
        currentContent = await this.app.vault.read(existingFile);
      } catch (error) {
        console.warn(
          `File exists in vault but cannot be read: ${filePath}. Creating new file.`
        );
        // If file can't be read, treat it as if it doesn't exist
        await this.app.vault.create(filePath, noteContent);
        return "created";
      }

      // Check if file was modified locally (protect local edits)
      const frontmatterMatch = currentContent.match(/^---\n([\s\S]*?)\n---/);

      // Check if frontmatter needs YAML escaping fix
      // (detect unescaped colons in title, url, etc.)
      const needsEscapingFix =
        frontmatterMatch &&
        !frontmatterMatch[1].includes('title: "') &&
        /title:.*:/.test(frontmatterMatch[1]);

      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        const lastSyncedMatch = frontmatter.match(/last_synced:\s*(.+)/);

        if (lastSyncedMatch) {
          const lastSynced = new Date(lastSyncedMatch[1]);
          const fileModified = new Date(existingFile.stat.mtime);

          // If file was modified after last sync, preserve the local notes
          if (fileModified > lastSynced) {
            console.log(`  🔒 File modified locally, preserving notes section`);

            // Extract local notes
            const localNotesMatch = currentContent.match(
              /## Notes\n+([\s\S]*?)$/
            );
            const localNotes = localNotesMatch ? localNotesMatch[1].trim() : "";

            // Generate new content with local notes preserved
            const newContentWithLocalNotes = noteContent.replace(
              /## Notes\n+([\s\S]*?)$/,
              `## Notes\n\n${localNotes}`
            );

            await this.app.vault.modify(existingFile, newContentWithLocalNotes);
            return "updated";
          }
        }
      }

      // Force update if file needs escaping fix (even if content is similar)
      if (needsEscapingFix) {
        console.log(
          `  🔧 Updating file with proper YAML escaping: ${filePath}`
        );
        await this.app.vault.modify(existingFile, noteContent);
        return "updated";
      }

      // Only update if content is different
      if (currentContent !== noteContent) {
        await this.app.vault.modify(existingFile, noteContent);
        return "updated";
      }
      return "skipped";
    } else {
      // Create new file
      await this.app.vault.create(filePath, noteContent);
      return "created";
    }
  }

  async findFileByRaindropId(raindropId: number): Promise<TFile | null> {
    const folder = this.app.vault.getAbstractFileByPath(
      normalizePath(this.settings.resourceFolder)
    );

    if (!(folder instanceof TFolder)) {
      return null;
    }

    const files = this.getAllFilesInFolder(folder);

    for (const file of files) {
      if (file.extension !== "md") continue;

      try {
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) continue;

        const frontmatter = frontmatterMatch[1];
        const raindropIdMatch = frontmatter.match(/raindrop_id:\s*(\d+)/);

        if (raindropIdMatch && parseInt(raindropIdMatch[1]) === raindropId) {
          return file;
        }
      } catch (error) {
        console.warn(`Skipping file ${file.path}: ${error.message}`);
        continue; // Skip files that can't be read
      }
    }

    return null;
  }

  sanitizeFileName(name: string): string {
    // Handle undefined or empty names
    if (!name || name.trim() === "") {
      return `Untitled-${Date.now()}`;
    }

    // Remove or replace invalid characters
    return name
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 200); // Limit length
  }

  async ensureUniqueFileName(
    folderPath: string,
    baseFileName: string,
    raindropId: number
  ): Promise<string> {
    let fileName = baseFileName;
    let counter = 1;
    const maxAttempts = 1000; // Prevent infinite loops

    while (counter < maxAttempts) {
      const filePath = normalizePath(`${folderPath}/${fileName}.md`);
      const existingFile = this.app.vault.getAbstractFileByPath(filePath);

      if (!existingFile) {
        // File doesn't exist, we can use this name
        return fileName;
      }

      // File exists, check if it's the same bookmark
      if (existingFile instanceof TFile) {
        try {
          const content = await this.app.vault.read(existingFile);
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

          if (frontmatterMatch) {
            const frontmatter = frontmatterMatch[1];
            const raindropIdMatch = frontmatter.match(/raindrop_id:\s*(\d+)/);

            if (raindropIdMatch && parseInt(raindropIdMatch[1]) === raindropId) {
              // Same bookmark, we can use this name (will update existing file)
              return fileName;
            }
          }
        } catch (error) {
          // If we can't read the file, assume it's a different bookmark
          console.warn(
            `Could not read existing file ${filePath}, will use different name`
          );
        }
      }

      // Different bookmark with same name, add counter
      counter++;
      fileName = `${baseFileName}-${counter}`;
    }

    // Fallback: use raindrop ID if we can't find a unique name
    console.warn(
      `Could not find unique filename for ${baseFileName}, using raindrop ID`
    );
    return `${baseFileName}-${raindropId}`;
  }

  escapeYamlValue(value: string): string {
    // If value is empty, return empty string
    if (!value) return '""';

    // Check if value needs quoting (contains special YAML characters)
    const needsQuoting =
      /[:\[\]{}#&*!|>'"%@`]/.test(value) ||
      value.startsWith(" ") ||
      value.endsWith(" ") ||
      value.includes("\n");

    if (!needsQuoting) {
      return value;
    }

    // Escape double quotes and backslashes, then wrap in quotes
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  generateNoteContent(
    bookmark: RaindropBookmark,
    collectionTitle: string = "Unsorted"
  ): string {
    const title = bookmark.title || "Untitled";

    // Convert Raindrop tags to Obsidian-friendly format
    // "AI in UX" -> "ai-in-ux"
    const sanitizeTags = (tags: string[]) => {
      return tags
        .map(
          (tag) =>
            tag
              .toLowerCase()
              .trim()
              .replace(/\s+/g, "-")
              .replace(/[^\w-]/g, "") // Remove special characters except hyphens
        )
        .filter((tag) => tag.length > 0); // Remove empty tags
    };

    const obsidianTags = sanitizeTags(bookmark.tags || []);

    // Add default tag for all Raindrop bookmarks
    if (!obsidianTags.includes("raindrop-bookmarks")) {
      obsidianTags.unshift("raindrop-bookmarks"); // Add at beginning
    }

    const inlineTags = obsidianTags.map((tag) => `#${tag}`);
    const tagsLine = inlineTags.length > 0 ? inlineTags.join(" ") : "";

    // Format tags properly for Obsidian properties
    let tagsYaml: string;
    if (obsidianTags.length === 0) {
      tagsYaml = "tags: []"; // Use inline format for empty arrays
    } else {
      tagsYaml = `tags:\n${obsidianTags.map((tag) => `  - ${tag}`).join("\n")}`;
    }

    // Escape YAML values that might contain special characters
    const escapedTitle = this.escapeYamlValue(title);
    const escapedUrl = this.escapeYamlValue(bookmark.link || "");
    const escapedCollection = this.escapeYamlValue(collectionTitle);
    const escapedDomain = this.escapeYamlValue(bookmark.domain || "Unknown");

    const content = `---
title: ${escapedTitle}
url: ${escapedUrl}
raindrop_id: ${bookmark._id}
collection: ${escapedCollection}
${tagsYaml}
created: ${bookmark.created}
last_synced: ${new Date().toISOString()}
type: raindrop-bookmark
domain: ${escapedDomain}
added: ${new Date(bookmark.created).toLocaleDateString()}
---

# ${title}

**URL:** [${bookmark.link || "No URL"}](${bookmark.link || "#"})
**Collection:** ${collectionTitle}
${tagsLine ? `**Tags:** ${tagsLine}` : ""}

## Notes

${bookmark.note || ""}
`;

    return content;
  }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  plugin: RaindropSyncPlugin;
  onChoose: (folder: TFolder) => void;

  constructor(
    app: App,
    plugin: RaindropSyncPlugin,
    onChoose: (folder: TFolder) => void
  ) {
    super(app);
    this.plugin = plugin;
    this.onChoose = onChoose;
  }

  getItems(): TFolder[] {
    const folders: TFolder[] = [];
    const abstractFiles = this.app.vault.getAllLoadedFiles();
    abstractFiles.forEach((file) => {
      if (file instanceof TFolder) {
        folders.push(file);
      }
    });
    return folders;
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}

class RaindropSyncSettingTab extends PluginSettingTab {
  plugin: RaindropSyncPlugin;

  constructor(app: App, plugin: RaindropSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getAllFolders(): string[] {
    const folders: string[] = [];
    const abstractFiles = this.app.vault.getAllLoadedFiles();
    abstractFiles.forEach((file) => {
      if (file instanceof TFolder) {
        folders.push(file.path);
      }
    });
    return folders.sort();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Raindrop Sync Settings" });

    // API Token
    new Setting(containerEl)
      .setName("Raindrop API Token")
      .setDesc(
        "Get your token from https://app.raindrop.io/settings/integrations"
      )
      .addText((text) =>
        text
          .setPlaceholder("Enter your API token")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
          })
      );

    // Test Connection Button
    new Setting(containerEl)
      .setName("Test Connection")
      .setDesc("Verify your API token is working")
      .addButton((button) =>
        button.setButtonText("Test Connection").onClick(async () => {
          await this.plugin.testConnection();
        })
      );

    // Resource Folder with enhanced UI and autocomplete
    const datalistId = "folder-suggestions-" + Date.now();
    const folderSetting = new Setting(containerEl)
      .setName("Bookmark Storage Folder")
      .setDesc(
        "Choose where your Raindrop bookmarks will be saved as Obsidian notes"
      )
      .addText((text) => {
        const inputEl = text.inputEl;

        text
          .setPlaceholder("e.g., Resources or Bookmarks/Raindrop")
          .setValue(this.plugin.settings.resourceFolder)
          .onChange(async (value) => {
            this.plugin.settings.resourceFolder = value;
            await this.plugin.saveSettings();
          });

        // Add datalist for autocomplete suggestions
        inputEl.setAttribute("list", datalistId);

        // Create datalist element with suggestions
        const datalist = containerEl.createEl("datalist", {
          attr: { id: datalistId },
        });

        // Add existing folders
        const folders = this.getAllFolders();
        folders.forEach((folder) => {
          datalist.createEl("option", { value: folder });
        });

        // Add common folder name suggestions
        const commonSuggestions = [
          "Resources",
          "Bookmarks",
          "Bookmarks/Raindrop",
          "04 Resources/Bookmarks",
          "02 Projects/Web Research",
        ];

        commonSuggestions.forEach((suggestion) => {
          if (!folders.includes(suggestion)) {
            datalist.createEl("option", { value: suggestion });
          }
        });
      })
      .addButton((button) =>
        button
          .setButtonText("Browse")
          .setTooltip("Choose from existing folders")
          .onClick(() => {
            const modal = new FolderSuggestModal(
              this.app,
              this.plugin,
              async (folder) => {
                this.plugin.settings.resourceFolder = folder.path;
                await this.plugin.saveSettings();
                this.display(); // Refresh the settings view
              }
            );
            modal.open();
          })
      )
      .addButton((button) =>
        button
          .setButtonText("Create Folder")
          .setTooltip("Create the folder if it doesn't exist")
          .onClick(async () => {
            try {
              await this.plugin.ensureFolderExists(
                this.plugin.settings.resourceFolder
              );
              new Notice(
                `✓ Folder "${this.plugin.settings.resourceFolder}" is ready!`
              );
            } catch (error) {
              new Notice("✗ Failed to create folder. Check the path.");
              console.error(error);
            }
          })
      );

    // Auto Sync Toggle
    new Setting(containerEl)
      .setName("Auto Sync")
      .setDesc("Automatically sync at regular intervals")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
          })
      );

    // Sync Interval
    new Setting(containerEl)
      .setName("Sync Interval")
      .setDesc("Minutes between automatic syncs")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.syncInterval))
          .onChange(async (value) => {
            const interval = parseInt(value);
            if (!isNaN(interval) && interval > 0) {
              this.plugin.settings.syncInterval = interval;
              await this.plugin.saveSettings();
            }
          })
      );

    // Section divider
    containerEl.createEl("h3", { text: "Sync Options" });

    // Test Mode Toggle
    new Setting(containerEl)
      .setName("Test Mode")
      .setDesc(
        "Enable test mode to sync only a limited number of items (useful for testing)"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.testMode)
          .onChange(async (value) => {
            this.plugin.settings.testMode = value;
            await this.plugin.saveSettings();
          })
      );

    // Test Mode Limit
    new Setting(containerEl)
      .setName("Test Mode Limit")
      .setDesc("Number of items to sync in test mode (default: 50)")
      .addText((text) =>
        text
          .setPlaceholder("50")
          .setValue(String(this.plugin.settings.testModeLimit))
          .onChange(async (value) => {
            const limit = parseInt(value);
            if (!isNaN(limit) && limit > 0) {
              this.plugin.settings.testModeLimit = limit;
              await this.plugin.saveSettings();
            }
          })
      );

    // Collection Folders Toggle
    new Setting(containerEl)
      .setName("Use Collection Folders")
      .setDesc(
        "Organize bookmarks into folders matching your Raindrop collections (e.g., Resources/Design, Resources/Development)"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useCollectionFolders)
          .onChange(async (value) => {
            this.plugin.settings.useCollectionFolders = value;
            await this.plugin.saveSettings();
          })
      );

    // Bidirectional Sync Toggle
    new Setting(containerEl)
      .setName("Bidirectional Sync")
      .setDesc(
        "Sync changes back to Raindrop when you edit the Description section in Obsidian notes"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.bidirectionalSync)
          .onChange(async (value) => {
            this.plugin.settings.bidirectionalSync = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
