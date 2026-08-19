# 📖 Backlink to Text

An efficient plugin designed for SiYuan Note, helping users quickly collect and organize current document's **backlinks** into structured lists, supporting **smart cursor positioning insertion** into the body text to make knowledge structuring easier.

---

## ✨ Key Features

*   🎯 **Smart Cursor Positioning**: Automatically detects the current cursor location.
    *   If the current line is **empty**, it updates the content directly on that line;
    *   If the current line **already has content**, it creates a **new line below** to insert the backlink list;
    *   If no valid cursor is found, it appends to the end of the document.
*   🔲 **Dual Display Interactive Panels**: Supports both **Popover Menu** (hung under the top bar, lightweight and quick) and **Dialog** (centered popup, spacious view) modes, switchable in settings.
*   📋 **Diverse List Formats**: Supports ordered lists (`1.`), unordered lists (`•`), task lists (`☑`), blockquotes (`▍`), and plain text paragraphs (`¶`).
*   🛠️ **Highly Flexible Template Engine**: Freely combine single backlink display formats using `${doc}` (backlink document) and `${content}` (corresponding reference text) tags.
*   🔗 **Flexible Citation Expressions**:
    *   Documents and texts support multiple formats: plain text, block reference `((id "title/text"))`, and hyperlink `[title](siyuan://...)`.
    *   Optionally toggle whether to retain the current document title text within the reference text.
*   🔄 **Smart State & Anti-Duplicate Sync**:
    *   Automatically checks/filters uninserted backlinks, with friendly markers for already inserted ones.
    *   If manually deleted from the document, the plugin automatically syncs state to allow re-insertion.

---

## 🚀 Quick Start

1. **Open Panel**:
   * Click the plugin top bar icon in the upper right corner of SiYuan Note.
   * Or use the command: `Generate Backlink List (Open Selection Panel)`.
2. **Select Backlinks**:
   * In the pop-up menu or dialog, the system automatically separates "Uninserted" and "Inserted" backlinks.
   * Quick actions: `Uninserted Only`, `Select All`, `Deselect All`, `Invert Selection`.
3. **Confirm Insertion**:
   * Check the desired backlink items and click "Insert Selected" to seamlessly insert them at the cursor position.

---

## ⚙️ Plugin Settings

Right-click the top bar icon or open via command `Backlink to Text Settings` to customize your preferences:

*   **Basic Rendering Structure**:
    *   **Display Mode**: Popover Menu / Centered Dialog
    *   **List Type**: Ordered / Unordered / Task / Blockquote / Paragraph
*   **Single Backlink Format Template**:
    *   Provides visual tag buttons (`${doc}`, `${content}`) and quick common presets.
*   **Citation Expression**:
    *   Set backlink document format (Plain Text / Block Reference / Hyperlink).
    *   Set reference text format (Plain Text / Block Reference / Hyperlink).
    *   Whether to show the current document title in the body text.

---

## ⌨️ Commands

*   **Generate Backlink List (Open Selection Panel)**: Quickly invoke the backlink selection interface.
*   **Backlink to Text Settings**: Quickly open the configuration center.

---

## 💡 Right-Click Menu

*   Right-click the top bar icon to directly open the quick menu for **Plugin Settings**.