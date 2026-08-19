"use strict";

const {
    Plugin,
    showMessage,
    Menu,
    fetchSyncPost,
    Dialog,
} = require("siyuan");

const STATE_KEY = "state-v2";
const SETTINGS_KEY = "settings-v2";

const DEFAULT_SETTINGS = {
    displayMode: "popover",      // "popover"（气泡菜单） | "dialog"（对话框）
    backlinkFormat: "text",      // "text" | "block_ref" | "hyperlink"
    contentFormat: "text",       // "text" | "block_ref" | "hyperlink"
    showCurrentDocTitle: false,  // boolean: 是否在对应文本中显示当前文档标题
    listType: "ordered",         // "ordered" | "unordered" | "task" | "blockquote" | "paragraph"
    itemTemplate: "${doc} - ${content}", // 自定义单条模板
};

class BacklinkToListPlugin extends Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData(SETTINGS_KEY));

        const btn = this.addTopBar({
            icon: "iconLink",
            title: "整理反链列表",
            position: "right",
            callback: (ev) => {
                this.handleTopBarClick(ev);
            },
        });

        btn.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            const menu = new Menu();
            menu.addItem({
                icon: "iconSettings",
                label: "插件设置",
                click: () => {
                    this.openSettingsDialog();
                },
            });
            menu.open({ x: ev.clientX, y: ev.clientY });
        });

        this.addCommand({
            langKey: "generateBacklinkList",
            langText: "整理反链列表（打开选择面板）",
            hotkey: "",
            callback: () => {
                const topBtn = document.querySelector('.toolbar__item[data-id="' + this.name + '"]');
                this.handleTopBarClick({ target: topBtn });
            },
        });
        this.addCommand({
            langKey: "openBacklinkSettings",
            langText: "反链整理插件设置",
            hotkey: "",
            callback: () => {
                this.openSettingsDialog();
            },
        });
    }

    /* ========== 顶栏点击路由分发 ========== */

    handleTopBarClick(event) {
        if (this.settings.displayMode === "dialog") {
            this.openBacklinkDialog();
        } else {
            this.openBacklinkMenu(event);
        }
    }

    /* ========== 当前文档与光标定位解析（已修复切换页面不更新问题） ========== */

    getCurrentDocId() {
        const selectors = [
            ".layout__wnd--active .protyle:not(.fn__none) .protyle-wysiwyg[data-node-id]",
            ".protyle:not(.fn__none) .protyle-wysiwyg[data-node-id]",
            ".layout__wnd--active .protyle:not(.fn__none) .protyle-title[data-node-id]",
            ".protyle:not(.fn__none) .protyle-title[data-node-id]",
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                const id = el.getAttribute("data-node-id");
                if (id && this.isValidId(id)) return id;
            }
        }
        return null;
    }

    getCurrentBlockId() {
        const selectors = [
            ".layout__wnd--active .protyle:not(.fn__none) .protyle-wysiwyg [data-node-id].protyle-wysiwyg--select",
            ".protyle:not(.fn__none) .protyle-wysiwyg [data-node-id].protyle-wysiwyg--select",
            ".layout__wnd--active .protyle:not(.fn__none) .protyle-wysiwyg [data-node-id].is-selected",
            ".layout__wnd--active .protyle:not(.fn__none) .protyle-wysiwyg [data-node-id]:focus",
            ".protyle:not(.fn__none) .protyle-wysiwyg [data-node-id].protyle-wysiwyg--select",
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                const id = el.getAttribute("data-node-id");
                if (id && this.isValidId(id)) return id;
            }
        }
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
            let node = selection.getRangeAt(0).commonAncestorContainer;
            if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
            const blockEl = node.closest ? node.closest(".protyle:not(.fn__none) [data-node-id]") || node.closest("[data-node-id]") : null;
            if (blockEl) {
                const id = blockEl.getAttribute("data-node-id");
                if (id && this.isValidId(id)) return id;
            }
        }
        return null;
    }

    isValidId(id) {
        return typeof id === "string" && /^[0-9]{14}-[0-9a-z]+$/.test(id);
    }

    async resolveDocId(id) {
        if (!this.isValidId(id)) return null;
        const res = await fetchSyncPost("/api/query/sql", {
            stmt: "SELECT id, root_id, type FROM blocks WHERE id = '" + id + "'",
        });
        const rows = (res && res.data) || [];
        if (rows.length === 0) return null;
        const row = rows[0];
        if (row.type === "d") return row.id;
        return row.root_id || row.id;
    }

    /* ========== 同步已被手动删除的块 ========== */

    async syncProcessedState(docId, state) {
        const docState = state[docId] || { processed: {}, generatedIds: [] };
        const processed = docState.processed || {};

        const trackedBlockIds = [];
        for (const sourceId in processed) {
            const val = processed[sourceId];
            if (typeof val === "string" && val) {
                trackedBlockIds.push(val);
            }
        }

        if (trackedBlockIds.length === 0) {
            docState.processed = {};
            docState.generatedIds = [];
            state[docId] = docState;
            await this.saveData(STATE_KEY, state);
            return docState;
        }

        const uniqueIds = [...new Set(trackedBlockIds)];
        const placeholders = uniqueIds.map((id) => "'" + id + "'").join(",");
        const sql = "SELECT id, type FROM blocks WHERE root_id = '" + docId + "' AND id IN (" + placeholders + ")";
        const res = await fetchSyncPost("/api/query/sql", { stmt: sql });
        const existingRows = (res && res.data) || [];

        const existingSet = new Set();
        for (const r of existingRows) {
            if (r.type !== "l") {
                existingSet.add(r.id);
            }
        }

        const newProcessed = {};
        for (const sourceId in processed) {
            const val = processed[sourceId];
            if (typeof val === "string" && existingSet.has(val)) {
                newProcessed[sourceId] = val;
            }
        }

        docState.processed = newProcessed;
        if (Array.isArray(docState.generatedIds)) {
            docState.generatedIds = docState.generatedIds.filter((id) => existingSet.has(id));
        }

        state[docId] = docState;
        await this.saveData(STATE_KEY, state);
        return docState;
    }

    /* ========== 模式 A：气泡菜单 (Popover Menu) ========== */

    async openBacklinkMenu(event) {
        const { docId, backlinks, titleMap, currentDocTitle, docState, defIds, currentBlockId } = await this.prepareBacklinkData();
        if (!docId || !backlinks) return;

        const preparedItems = backlinks.map(bl => {
            const docTitle = titleMap[bl.root_id] || "未命名文档";
            const raw = bl.content || bl.markdown || "";
            const plainText = this.toPlainText(raw, docId, currentDocTitle, this.settings.showCurrentDocTitle, defIds);
            const isInserted = !!docState.processed[bl.id];
            return { bl, docTitle, plainText, isInserted };
        });

        const uninsertedItems = preparedItems.filter((i) => !i.isInserted);
        const insertedItems = preparedItems.filter((i) => i.isInserted);

        const menu = new Menu("b2l-popover-menu");
        
        const renderItemList = (items, defaultChecked) => {
            if (items.length === 0) {
                return `<div style="font-size: 12px; color: var(--b3-theme-on-surface); padding: 8px; text-align: center;">暂无数据</div>`;
            }
            return items
                .map(
                    (item) => `
                <label style="display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; background: var(--b3-theme-background); border-radius: 4px; margin-bottom: 4px; cursor: pointer; border: 1px solid var(--b3-theme-surface-lighter);">
                    <input type="checkbox" class="b2l-cb" data-id="${item.bl.id}" ${defaultChecked && !item.isInserted ? "checked" : ""} style="margin-top: 3px;" />
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-size: 12px; font-weight: 600; color: var(--b3-theme-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${this.escapeHtml(item.docTitle)}
                        </div>
                        <div style="font-size: 11px; color: var(--b3-theme-on-background); opacity: 0.8; word-break: break-all; line-height: 1.3;">
                            ${this.escapeHtml(item.plainText || "（无关联文本内容）")}
                        </div>
                    </div>
                </label>`
                )
                .join("");
        };

        const popoverContainer = document.createElement("div");
        popoverContainer.style.cssText = "width: 320px; max-height: 520px; padding: 12px; display: flex; flex-direction: column; gap: 10px; box-sizing: border-box;";

        popoverContainer.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--b3-theme-surface-lighter); padding-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-weight: bold; font-size: 14px;">整理反链</span>
                    <span style="font-size: 11px; padding: 1px 5px; background: var(--b3-theme-surface-lighter); border-radius: 8px; color: var(--b3-theme-on-surface);">共 ${backlinks.length} 条</span>
                </div>
                <button id="b2l-open-settings" class="b3-button b3-button--outline" style="padding: 2px 6px; font-size: 11px;">⚙️ 设置</button>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; background: var(--b3-theme-surface-lighter); padding: 4px 6px; border-radius: 4px;">
                <span style="font-size: 11px; color: var(--b3-theme-on-surface);">选择：</span>
                <div style="display: flex; gap: 4px;">
                    <button id="b2l-btn-uninserted" class="b3-button b3-button--outline" style="padding: 1px 5px; font-size: 11px;">未插入</button>
                    <button id="b2l-btn-all" class="b3-button b3-button--outline" style="padding: 1px 5px; font-size: 11px;">全选</button>
                    <button id="b2l-btn-none" class="b3-button b3-button--outline" style="padding: 1px 5px; font-size: 11px;">全不选</button>
                    <button id="b2l-btn-invert" class="b3-button b3-button--outline" style="padding: 1px 5px; font-size: 11px;">反选</button>
                </div>
            </div>

            <div style="flex: 1; overflow-y: auto; max-height: 360px; border: 1px solid var(--b3-theme-surface-lighter); border-radius: 4px; padding: 6px; display: flex; flex-direction: column; gap: 10px;">
                <div>
                    <div style="font-weight: bold; color: var(--b3-theme-primary); margin-bottom: 6px; font-size: 12px;">📌 未插入 (${uninsertedItems.length})</div>
                    ${renderItemList(uninsertedItems, true)}
                </div>
                <div>
                    <div style="font-weight: bold; color: var(--b3-theme-on-surface); margin-bottom: 6px; font-size: 12px;">✅ 已插入 (${insertedItems.length})</div>
                    ${renderItemList(insertedItems, false)}
                </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 8px; padding-top: 2px;">
                <button id="b2l-btn-submit" class="b3-button b3-button--text" style="width: 100%; padding: 4px 0; font-size: 12px;">插入选中项</button>
            </div>
        `;

        menu.addItem({ element: popoverContainer });

        const targetEl = event && event.target ? event.target.closest(".toolbar__item, button") || event.target : null;
        if (targetEl) {
            const rect = targetEl.getBoundingClientRect();
            menu.open({ x: rect.right, y: rect.bottom, isSubMenu: false });
        } else {
            menu.open({ x: window.innerWidth - 340, y: 48 });
        }

        const getCheckboxes = () => popoverContainer.querySelectorAll(".b2l-cb");

        popoverContainer.querySelector("#b2l-open-settings").addEventListener("click", () => {
            menu.close();
            this.openSettingsDialog();
        });

        popoverContainer.querySelector("#b2l-btn-uninserted").addEventListener("click", () => {
            const insertedSet = new Set(insertedItems.map((i) => i.bl.id));
            getCheckboxes().forEach((cb) => { cb.checked = !insertedSet.has(cb.dataset.id); });
        });
        popoverContainer.querySelector("#b2l-btn-all").addEventListener("click", () => {
            getCheckboxes().forEach((cb) => (cb.checked = true));
        });
        popoverContainer.querySelector("#b2l-btn-none").addEventListener("click", () => {
            getCheckboxes().forEach((cb) => (cb.checked = false));
        });
        popoverContainer.querySelector("#b2l-btn-invert").addEventListener("click", () => {
            getCheckboxes().forEach((cb) => (cb.checked = !cb.checked));
        });

        popoverContainer.querySelector("#b2l-btn-submit").addEventListener("click", async () => {
            const selectedIds = new Set();
            getCheckboxes().forEach((cb) => { if (cb.checked) selectedIds.add(cb.dataset.id); });

            if (selectedIds.size === 0) {
                showMessage("请至少选择一条需要插入的反链", 3000, "info");
                return;
            }

            menu.close();
            await this.executeInsert(docId, backlinks, selectedIds, titleMap, currentDocTitle, defIds, currentBlockId);
        });
    }

    /* ========== 模式 B：对话框弹窗 (Dialog) ========== */

    async openBacklinkDialog() {
        const { docId, backlinks, titleMap, currentDocTitle, docState, defIds, currentBlockId } = await this.prepareBacklinkData();
        if (!docId || !backlinks) return;

        const preparedItems = backlinks.map(bl => {
            const docTitle = titleMap[bl.root_id] || "未命名文档";
            const raw = bl.content || bl.markdown || "";
            const plainText = this.toPlainText(raw, docId, currentDocTitle, this.settings.showCurrentDocTitle, defIds);
            const isInserted = !!docState.processed[bl.id];
            return { bl, docTitle, plainText, isInserted };
        });

        const uninsertedItems = preparedItems.filter((i) => !i.isInserted);
        const insertedItems = preparedItems.filter((i) => i.isInserted);

        const dialogContent = document.createElement("div");
        dialogContent.style.cssText = "padding: 16px; display: flex; flex-direction: column; gap: 12px; max-height: 75vh;";

        const renderItemList = (items, defaultChecked) => {
            if (items.length === 0) {
                return `<div style="font-size: 12px; color: var(--b3-theme-on-surface); padding: 12px; text-align: center;">暂无数据</div>`;
            }
            return items
                .map(
                    (item) => `
                <label style="display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; background: var(--b3-theme-surface); border-radius: 6px; margin-bottom: 6px; cursor: pointer; border: 1px solid var(--b3-theme-surface-lighter);">
                    <input type="checkbox" class="b2l-cb" data-id="${item.bl.id}" ${defaultChecked && !item.isInserted ? "checked" : ""} style="margin-top: 3px;" />
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-size: 12px; font-weight: 600; color: var(--b3-theme-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px;">
                            ${this.escapeHtml(item.docTitle)}
                        </div>
                        <div style="font-size: 12px; color: var(--b3-theme-on-background); opacity: 0.85; word-break: break-all; line-height: 1.4;">
                            ${this.escapeHtml(item.plainText || "（无关联文本内容）")}
                        </div>
                    </div>
                </label>`
                )
                .join("");
        };

        dialogContent.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--b3-theme-surface-lighter); padding-bottom: 10px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-weight: bold; font-size: 15px;">整理反链</span>
                    <span style="font-size: 12px; padding: 2px 6px; background: var(--b3-theme-surface); border-radius: 10px; color: var(--b3-theme-on-surface);">共 ${backlinks.length} 条</span>
                </div>
                <button id="b2l-open-settings" class="b3-button b3-button--outline" style="padding: 3px 10px; font-size: 12px; display: flex; align-items: center; gap: 4px;">⚙️ 插件设置</button>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; background: var(--b3-theme-surface); padding: 6px 10px; border-radius: 6px;">
                <span style="font-size: 12px; color: var(--b3-theme-on-surface); font-weight: 500;">快捷选择：</span>
                <div style="display: flex; gap: 6px;">
                    <button id="b2l-btn-uninserted" class="b3-button b3-button--outline" style="padding: 2px 8px; font-size: 12px;">仅未插入</button>
                    <button id="b2l-btn-all" class="b3-button b3-button--outline" style="padding: 2px 8px; font-size: 12px;">全选</button>
                    <button id="b2l-btn-none" class="b3-button b3-button--outline" style="padding: 2px 8px; font-size: 12px;">全不选</button>
                    <button id="b2l-btn-invert" class="b3-button b3-button--outline" style="padding: 2px 8px; font-size: 12px;">反选</button>
                </div>
            </div>

            <div style="flex: 1; overflow-y: auto; border: 1px solid var(--b3-theme-surface-lighter); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 14px;">
                <div>
                    <div style="font-weight: bold; color: var(--b3-theme-primary); margin-bottom: 8px; font-size: 13px;">📌 未插入的反链 (${uninsertedItems.length})</div>
                    ${renderItemList(uninsertedItems, true)}
                </div>
                <div>
                    <div style="font-weight: bold; color: var(--b3-theme-on-surface); margin-bottom: 8px; font-size: 13px;">✅ 已插入的反链 (${insertedItems.length})</div>
                    ${renderItemList(insertedItems, false)}
                </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px; padding-top: 4px;">
                <button id="b2l-btn-cancel" class="b3-button b3-button--cancel">取消</button>
                <button id="b2l-btn-submit" class="b3-button b3-button--text" style="padding: 6px 16px;">插入选中项</button>
            </div>
        `;

        const dialog = new Dialog({ title: "", content: "", width: "650px" });
        dialog.element.querySelector(".b3-dialog__body").appendChild(dialogContent);

        const getCheckboxes = () => dialogContent.querySelectorAll(".b2l-cb");

        dialogContent.querySelector("#b2l-open-settings").addEventListener("click", () => {
            dialog.destroy();
            this.openSettingsDialog();
        });

        dialogContent.querySelector("#b2l-btn-uninserted").addEventListener("click", () => {
            const insertedSet = new Set(insertedItems.map((i) => i.bl.id));
            getCheckboxes().forEach((cb) => { cb.checked = !insertedSet.has(cb.dataset.id); });
        });
        dialogContent.querySelector("#b2l-btn-all").addEventListener("click", () => {
            getCheckboxes().forEach((cb) => (cb.checked = true));
        });
        dialogContent.querySelector("#b2l-btn-none").addEventListener("click", () => {
            getCheckboxes().forEach((cb) => (cb.checked = false));
        });
        dialogContent.querySelector("#b2l-btn-invert").addEventListener("click", () => {
            getCheckboxes().forEach((cb) => (cb.checked = !cb.checked));
        });

        dialogContent.querySelector("#b2l-btn-cancel").addEventListener("click", () => dialog.destroy());

        dialogContent.querySelector("#b2l-btn-submit").addEventListener("click", async () => {
            const selectedIds = new Set();
            getCheckboxes().forEach((cb) => { if (cb.checked) selectedIds.add(cb.dataset.id); });

            if (selectedIds.size === 0) {
                showMessage("请至少选择一条需要插入的反链", 3000, "info");
                return;
            }

            dialog.destroy();
            await this.executeInsert(docId, backlinks, selectedIds, titleMap, currentDocTitle, defIds, currentBlockId);
        });
    }

    /* ========== 数据公共准备层 ========== */

    async prepareBacklinkData() {
        const rawId = this.getCurrentDocId();
        const currentBlockId = this.getCurrentBlockId();
        if (!rawId) {
            showMessage("未找到当前文档，请先打开一个文档", 3000, "error");
            return {};
        }
        const docId = await this.resolveDocId(rawId);
        if (!docId) {
            showMessage("无法解析当前文档 ID", 3000, "error");
            return {};
        }

        const state = (await this.loadData(STATE_KEY)) || {};
        const docState = await this.syncProcessedState(docId, state);

        const { backlinks, defIds } = await this.queryBacklinks(docId);
        if (backlinks.length === 0) {
            showMessage("当前文档没有反链", 3000, "info");
            return {};
        }

        const titleMap = await this.queryDocTitles(backlinks);
        let currentDocTitle = "";
        try {
            const tRes = await fetchSyncPost("/api/query/sql", {
                stmt: "SELECT content FROM blocks WHERE id = '" + docId + "' AND type = 'd'",
            });
            const tRows = (tRes && tRes.data) || [];
            if (tRows.length > 0) currentDocTitle = tRows[0].content || "";
        } catch (e) {}

        return { docId, backlinks, titleMap, currentDocTitle, docState, defIds, currentBlockId };
    }

    /* ========== 设置面板优化（新增展示模式切换） ========== */

    openSettingsDialog() {
        const dialogContent = document.createElement("div");
        dialogContent.style.cssText = "padding: 18px; display: flex; flex-direction: column; gap: 16px;";

        dialogContent.innerHTML = `
            <div style="font-weight: bold; font-size: 16px; border-bottom: 1px solid var(--b3-theme-surface-lighter); padding-bottom: 10px;">
                ⚙️ 反链整理 - 插件设置
            </div>

            <div style="display: flex; flex-direction: column; gap: 16px; font-size: 13px;">
                
                <!-- 1. 结构与格式选择 -->
                <div style="background: var(--b3-theme-surface); padding: 12px; border-radius: 6px; border: 1px solid var(--b3-theme-surface-lighter); display: flex; flex-direction: column; gap: 10px;">
                    <div style="font-weight: bold; color: var(--b3-theme-primary); font-size: 13px;">基本渲染结构</div>
                    
                    <label style="display: flex; justify-content: space-between; align-items: center;">
                        <span>面板展示模式：</span>
                        <select id="b2l-set-displayMode" class="b3-select" style="width: 220px;">
                            <option value="popover" ${this.settings.displayMode === "popover" ? "selected" : ""}>气泡菜单（悬挂顶栏下方）</option>
                            <option value="dialog" ${this.settings.displayMode === "dialog" ? "selected" : ""}>对话框（居中弹窗）</option>
                        </select>
                    </label>

                    <label style="display: flex; justify-content: space-between; align-items: center;">
                        <span>整体列表格式：</span>
                        <select id="b2l-set-listType" class="b3-select" style="width: 220px;">
                            <option value="ordered" ${this.settings.listType === "ordered" ? "selected" : ""}>1. 数字列表</option>
                            <option value="unordered" ${this.settings.listType === "unordered" ? "selected" : ""}>• 无序列表</option>
                            <option value="task" ${this.settings.listType === "task" ? "selected" : ""}>☑ 任务列表</option>
                            <option value="blockquote" ${this.settings.listType === "blockquote" ? "selected" : ""}>▍ 引用块</option>
                            <option value="paragraph" ${this.settings.listType === "paragraph" ? "selected" : ""}>¶ 纯文本段落</option>
                        </select>
                    </label>
                </div>

                <!-- 2. 单条反链模板配置 -->
                <div style="background: var(--b3-theme-surface); padding: 12px; border-radius: 6px; border: 1px solid var(--b3-theme-surface-lighter); display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight: bold; color: var(--b3-theme-primary); font-size: 13px;">单条反链格式模板</span>
                        <div style="display: flex; gap: 6px;">
                            <button type="button" class="b3-button b3-button--outline b2l-tpl-btn" data-tag="\${doc}" style="padding: 2px 8px; font-size: 11px;">+ \${doc}</button>
                            <button type="button" class="b3-button b3-button--outline b2l-tpl-btn" data-tag="\${content}" style="padding: 2px 8px; font-size: 11px;">+ \${content}</button>
                        </div>
                    </div>
                    
                    <input id="b2l-set-itemTemplate" class="b3-text-field" value="${this.escapeHtml(this.settings.itemTemplate || "${doc} - ${content}")}" placeholder="\${doc} - \${content}" style="width: 100%; font-family: monospace; font-size: 13px;" />
                    
                    <div style="display: flex; items-center; gap: 8px; font-size: 11px; color: var(--b3-theme-on-surface);">
                        <span>常用预设：</span>
                        <a href="javascript:void(0)" class="b2l-preset" data-val="\${doc} - \${content}" style="color: var(--b3-theme-primary); text-decoration: underline;">标准 (- 分隔)</a>
                        <a href="javascript:void(0)" class="b2l-preset" data-val="📌 [\${doc}] \${content}" style="color: var(--b3-theme-primary); text-decoration: underline;">带前缀</a>
                        <a href="javascript:void(0)" class="b2l-preset" data-val="\${doc}：\${content}" style="color: var(--b3-theme-primary); text-decoration: underline;">冒号分隔</a>
                    </div>
                </div>

                <!-- 3. 引用模式设置 -->
                <div style="background: var(--b3-theme-surface); padding: 12px; border-radius: 6px; border: 1px solid var(--b3-theme-surface-lighter); display: flex; flex-direction: column; gap: 10px;">
                    <div style="font-weight: bold; color: var(--b3-theme-primary); font-size: 13px;">引用表达方式</div>
                    
                    <label style="display: flex; justify-content: space-between; align-items: center;">
                        <span>反链文档 \${doc} 格式：</span>
                        <select id="b2l-set-backlinkFormat" class="b3-select" style="width: 220px;">
                            <option value="text" ${this.settings.backlinkFormat === "text" ? "selected" : ""}>纯文本</option>
                            <option value="block_ref" ${this.settings.backlinkFormat === "block_ref" ? "selected" : ""}>块引用 ((id "标题"))</option>
                            <option value="hyperlink" ${this.settings.backlinkFormat === "hyperlink" ? "selected" : ""}>超链接 [标题](siyuan://)</option>
                        </select>
                    </label>

                    <label style="display: flex; justify-content: space-between; align-items: center;">
                        <span>对应文本 \${content} 格式：</span>
                        <select id="b2l-set-contentFormat" class="b3-select" style="width: 220px;">
                            <option value="text" ${this.settings.contentFormat === "text" ? "selected" : ""}>纯文本</option>
                            <option value="block_ref" ${this.settings.contentFormat === "block_ref" ? "selected" : ""}>块引用 ((id "文本"))</option>
                            <option value="hyperlink" ${this.settings.contentFormat === "hyperlink" ? "selected" : ""}>超链接 [文本](siyuan://)</option>
                        </select>
                    </label>

                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin-top: 4px;">
                        <input type="checkbox" id="b2l-set-showDocTitle" ${this.settings.showCurrentDocTitle ? "checked" : ""} />
                        <span>在对应文本中保留显示当前文档标题字样</span>
                    </label>
                </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px;">
                <button id="b2l-set-cancel" class="b3-button b3-button--cancel">取消</button>
                <button id="b2l-set-save" class="b3-button b3-button--text" style="padding: 6px 16px;">保存设置</button>
            </div>
        `;

        const dialog = new Dialog({ title: "", content: "", width: "520px" });
        dialog.element.querySelector(".b3-dialog__body").appendChild(dialogContent);

        const tplInput = dialogContent.querySelector("#b2l-set-itemTemplate");

        dialogContent.querySelectorAll(".b2l-tpl-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const tag = btn.dataset.tag;
                const start = tplInput.selectionStart || tplInput.value.length;
                const end = tplInput.selectionEnd || tplInput.value.length;
                const val = tplInput.value;
                tplInput.value = val.substring(0, start) + tag + val.substring(end);
                tplInput.focus();
                tplInput.setSelectionRange(start + tag.length, start + tag.length);
            });
        });

        dialogContent.querySelectorAll(".b2l-preset").forEach((a) => {
            a.addEventListener("click", () => {
                tplInput.value = a.dataset.val;
            });
        });

        dialogContent.querySelector("#b2l-set-cancel").addEventListener("click", () => dialog.destroy());
        dialogContent.querySelector("#b2l-set-save").addEventListener("click", async () => {
            this.settings.displayMode = dialogContent.querySelector("#b2l-set-displayMode").value;
            this.settings.listType = dialogContent.querySelector("#b2l-set-listType").value;
            this.settings.itemTemplate = dialogContent.querySelector("#b2l-set-itemTemplate").value || "${doc} - ${content}";
            this.settings.backlinkFormat = dialogContent.querySelector("#b2l-set-backlinkFormat").value;
            this.settings.contentFormat = dialogContent.querySelector("#b2l-set-contentFormat").value;
            this.settings.showCurrentDocTitle = dialogContent.querySelector("#b2l-set-showDocTitle").checked;

            await this.saveData(SETTINGS_KEY, this.settings);
            showMessage("设置已保存", 3000, "info");
            dialog.destroy();
        });
    }

    /* ========== 数据查询、递归及组装保持不变 ========== */

    async queryBacklinks(docId) {
        const sql =
            "SELECT b.id AS id, b.root_id AS root_id, b.type AS type, b.subtype AS subtype, " +
            "b.content AS content, b.markdown AS markdown, " +
            "p.id AS parent_id, p.type AS parent_type, p.content AS parent_content, p.markdown AS parent_markdown, " +
            "r.def_block_id AS def_block_id, r.content AS ref_content " +
            "FROM blocks b " +
            "LEFT JOIN blocks p ON b.parent_id = p.id " +
            "JOIN refs r ON b.id = r.block_id " +
            "WHERE r.def_block_root_id = '" + docId + "'";
        const res = await fetchSyncPost("/api/query/sql", { stmt: sql });
        const rows = (res && res.data) || [];

        const defIds = new Set();
        const seen = new Set();
        const backlinks = [];
        for (const row of rows) {
            if (row.def_block_id) defIds.add(row.def_block_id);
            let eff = row;
            if (row.parent_type === "i") {
                eff = {
                    id: row.parent_id,
                    root_id: row.root_id,
                    type: "i",
                    subtype: row.subtype,
                    content: row.content || row.parent_content || "",
                    markdown: row.markdown || row.parent_markdown || "",
                    ref_content: row.ref_content || "",
                    _refBlockId: row.id,
                };
            }
            if (seen.has(eff.id)) continue;
            seen.add(eff.id);
            backlinks.push(eff);
        }
        defIds.add(docId);
        return { backlinks, defIds };
    }

    async queryDocTitles(backlinks) {
        const rootIds = [...new Set(backlinks.map((b) => b.root_id).filter(Boolean))];
        const titleMap = {};
        if (rootIds.length === 0) return titleMap;
        const titleSql =
            "SELECT id, content FROM blocks WHERE type = 'd' AND id IN (" +
            rootIds.map((id) => "'" + id + "'").join(",") +
            ")";
        const titleRes = await fetchSyncPost("/api/query/sql", { stmt: titleSql });
        ((titleRes && titleRes.data) || []).forEach((r) => {
            titleMap[r.id] = r.content || "";
        });
        return titleMap;
    }

    async collectChildren(blockId, docId, docTitle, depth, skipId, defIds) {
        const res = await fetchSyncPost("/api/block/getChildBlocks", { id: blockId });
        const children = (res && res.data) || [];
        const result = [];
        for (const child of children) {
            if (skipId && child.id === skipId) {
                const sub = await this.collectChildren(child.id, docId, docTitle, depth + 1, null, defIds);
                for (const s of sub) result.push(s);
                continue;
            }
            const raw = child.content || child.markdown || "";
            const text = this.toPlainText(raw, docId, docTitle, this.settings.showCurrentDocTitle, defIds);
            const sub = await this.collectChildren(child.id, docId, docTitle, depth + 1, null, defIds);
            if (text || sub.length > 0) {
                result.push({ id: child.id, text, depth, children: sub });
            }
        }
        return result;
    }

    toPlainText(md, docId, docTitle, showCurrentDocTitle, defIds) {
        if (!md) return "";
        let text = String(md);

        text = text.replace(
            /\(\(([0-9a-zA-Z_-]+)(?:\s+(?:"([^"]*)"|'([^']*)'|\u201c([^\u201d]*)\u201d|\u2018([^\u2019]*)\u2019))?\s*\)\)/g,
            (m, id, a1, a2, a3, a4) => {
                const anchor = a1 || a2 || a3 || a4 || "";
                const isCurrentDoc = id === docId || (defIds && defIds.has(id));
                if (isCurrentDoc) {
                    return showCurrentDocTitle ? (anchor || docTitle || "") : "";
                }
                return anchor || "";
            }
        );

        text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, target, alias) => {
            const disp = alias || target || "";
            if (!showCurrentDocTitle && docTitle && (target === docTitle || alias === docTitle)) {
                return "";
            }
            return disp;
        });

        text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
        text = text.replace(/<[^>]+>/g, "");
        text = text.replace(/^\s*#{1,6}\s+/gm, "");
        text = text.replace(/^\s*>\s?/gm, "");
        text = text.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX\u2610\u2612]\]\s*)?/gm, "");
        text = text.replace(/^\s*\[[ xX\u2610\u2612]\]\s*/gm, "");

        text = text.replace(/\*\*([\s\S]*?)\*\*/g, "$1");
        text = text.replace(/__([\s\S]*?)__/g, "$1");
        text = text.replace(/~~([\s\S]*?)~~/g, "$1");
        text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
        text = text.replace(/`([^`]+)`/g, "$1");

        text = text.replace(/&nbsp;/g, " ");
        text = text.replace(/&amp;/g, "&");
        text = text.replace(/&lt;/g, "<");
        text = text.replace(/&gt;/g, ">");
        text = text.replace(/&quot;/g, '"');

        if (!showCurrentDocTitle && docTitle && docTitle.trim() !== "") {
            text = text.split(docTitle).join("");
        }

        text = text.replace(/\s*\n\s*/g, " ");
        text = text.replace(/\(\([^()]*\)\)/g, "");
        text = text.replace(/[ \t]+/g, " ").trim();

        return text;
    }

    formatBacklink(rootId, docTitle, format) {
        if (!docTitle) return "";
        const safeTitle = String(docTitle).replace(/"/g, '“').replace(/[\r\n]+/g, " ");
        if (format === "block_ref") {
            return `((${rootId} "${safeTitle}"))`;
        } else if (format === "hyperlink") {
            return `[${safeTitle}](siyuan://blocks/${rootId})`;
        }
        return safeTitle;
    }

    formatContent(blockId, text, format) {
        if (!text) return "";
        const safeText = String(text).replace(/"/g, '“').replace(/[\r\n]+/g, " ");
        if (format === "block_ref") {
            return `((${blockId} "${safeText}"))`;
        } else if (format === "hyperlink") {
            return `[${safeText}](siyuan://blocks/${blockId})`;
        }
        return safeText;
    }

    buildMarkdown(items) {
        const lines = [];
        const listType = this.settings.listType || "ordered";
        const template = this.settings.itemTemplate || "${doc} - ${content}";

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const formattedDoc = this.formatBacklink(item.rootId, item.docTitle, this.settings.backlinkFormat);
            const formattedText = this.formatContent(item.sourceId, item.text, this.settings.contentFormat);

            let head = template
                .replace(/\$\{doc\}/g, formattedDoc)
                .replace(/\$\{docTitle\}/g, formattedDoc)
                .replace(/\$\{content\}/g, formattedText);

            head = head.replace(/^[\s\-:\u2014]+|[\s\-:\u2014]+$/g, "").trim();

            let prefix = "";
            if (listType === "ordered") {
                prefix = `${i + 1}. `;
            } else if (listType === "unordered") {
                prefix = "* ";
            } else if (listType === "task") {
                prefix = "* [ ] ";
            } else if (listType === "blockquote") {
                prefix = "> ";
            } else if (listType === "paragraph") {
                prefix = "";
            }

            lines.push(prefix + head);
            this.appendChildren(lines, item.children, 1, listType);
        }

        return lines.join("\n");
    }

    appendChildren(lines, children, depth, listType) {
        for (const child of children) {
            const formattedChildText = this.formatContent(child.id, child.text, this.settings.contentFormat);
            if (formattedChildText) {
                let childPrefix = "";
                const indent = "    ".repeat(depth);

                if (listType === "ordered" || listType === "unordered") {
                    childPrefix = indent + "* ";
                } else if (listType === "task") {
                    childPrefix = indent + "* [ ] ";
                } else if (listType === "blockquote") {
                    childPrefix = "> ".repeat(depth + 1);
                } else if (listType === "paragraph") {
                    childPrefix = indent;
                }

                lines.push(childPrefix + formattedChildText);
            }
            this.appendChildren(lines, child.children, depth + 1, listType);
        }
    }

    extractListItemIds(data) {
        const itemIds = [];
        const ops = Array.isArray(data) ? data : data ? [data] : [];
        const parser = new DOMParser();

        for (const op of ops) {
            if (op && Array.isArray(op.doOperations)) {
                for (const d of op.doOperations) {
                    if (d && d.data && typeof d.data === "string") {
                        try {
                            const doc = parser.parseFromString(d.data, "text/html");
                            const topListEls = doc.querySelectorAll('body > [data-type="NodeList"], body > .list, [data-type="NodeList"]');
                            if (topListEls.length > 0) {
                                const rootList = topListEls[0];
                                for (const child of rootList.children) {
                                    const dataType = child.getAttribute("data-type");
                                    const isLi = dataType === "NodeListItem" || child.classList.contains("li");
                                    if (isLi) {
                                        const id = child.getAttribute("data-node-id");
                                        if (id && this.isValidId(id)) {
                                            itemIds.push(id);
                                        }
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
        }
        return itemIds;
    }

    async executeInsert(docId, allBacklinks, targetIds, titleMap, currentDocTitle, defIds, currentBlockId) {
        try {
            const state = (await this.loadData(STATE_KEY)) || {};
            const docState = state[docId] || { processed: {}, generatedIds: [] };

            const targetBacklinks = allBacklinks.filter((b) => targetIds.has(b.id));
            if (targetBacklinks.length === 0) {
                showMessage("没有需要处理的反链", 3000, "info");
                return;
            }

            const items = [];
            for (const bl of targetBacklinks) {
                const docTitle = titleMap[bl.root_id] || "未命名文档";
                const raw = bl.content || bl.markdown || "";
                const mainText = this.toPlainText(raw, docId, currentDocTitle, this.settings.showCurrentDocTitle, defIds);

                let children = [];
                if (bl.type === "i") {
                    children = await this.collectChildren(
                        bl.id,
                        docId,
                        currentDocTitle,
                        1,
                        bl._refBlockId || null,
                        defIds
                    );
                }
                items.push({
                    rootId: bl.root_id,
                    sourceId: bl.id,
                    docTitle,
                    text: mainText,
                    children,
                });
            }

            const md = this.buildMarkdown(items);

            let insertRes = null;
            let targetIdToUse = currentBlockId;

            // 检查当前光标所在块是否有效并属于当前文档
            if (targetIdToUse) {
                const checkRes = await fetchSyncPost("/api/query/sql", {
                    stmt: "SELECT id, root_id, type, content, markdown FROM blocks WHERE id = '" + targetIdToUse + "'",
                });
                const rows = (checkRes && checkRes.data) || [];
                if (rows.length > 0 && rows[0].root_id === docId) {
                    const row = rows[0];
                    const isEmpty = !(row.content || row.markdown || "").trim();
                    // 如果当前块为空且是文本类块（如段落、标题等），直接更新该块；否则在其下方新建一行插入
                    if (isEmpty && ["p", "h", "text"].includes(row.type) || (isEmpty && row.type !== "d")) {
                        insertRes = await fetchSyncPost("/api/block/updateBlock", {
                            dataType: "markdown",
                            data: md,
                            id: targetIdToUse,
                        });
                    } else {
                        insertRes = await fetchSyncPost("/api/block/insertBlock", {
                            dataType: "markdown",
                            data: md,
                            previousID: targetIdToUse,
                        });
                    }
                }
            }

            // 如果没有有效光标位置或请求失败，退回到文档末尾追加
            if (!insertRes || insertRes.code !== 0) {
                insertRes = await fetchSyncPost("/api/block/appendBlock", {
                    dataType: "markdown",
                    data: md,
                    parentID: docId,
                });
            }

            if (!insertRes || insertRes.code !== 0) {
                showMessage("插入失败：" + ((insertRes && insertRes.msg) || "未知错误"), 5000, "error");
                return;
            }

            const listItemIds = this.extractListItemIds(insertRes.data);
            const topLevelBlockIds = this.extractBlockIds(insertRes.data);

            if (listItemIds.length === items.length) {
                for (let i = 0; i < items.length; i++) {
                    docState.processed[items[i].sourceId] = listItemIds[i];
                }
            } else if (topLevelBlockIds.length === items.length) {
                for (let i = 0; i < items.length; i++) {
                    docState.processed[items[i].sourceId] = topLevelBlockIds[i];
                }
            } else {
                for (let i = 0; i < items.length; i++) {
                    if (topLevelBlockIds[i]) {
                        docState.processed[items[i].sourceId] = topLevelBlockIds[i];
                    }
                }
            }

            const allCreated = this.extractBlockIds(insertRes.data);
            docState.generatedIds = [...new Set((docState.generatedIds || []).concat(allCreated))];
            state[docId] = docState;
            await this.saveData(STATE_KEY, state);

            showMessage("成功整理 " + items.length + " 条反链", 3000, "info");
        } catch (e) {
            showMessage("整理反链失败：" + (e && e.message ? e.message : String(e)), 5000, "error");
        }
    }

    extractBlockIds(data) {
        const ids = [];
        const ops = Array.isArray(data) ? data : data ? [data] : [];
        for (const op of ops) {
            if (op && Array.isArray(op.doOperations)) {
                for (const d of op.doOperations) {
                    if (d && d.id && (!d.action || d.action === "insert")) {
                        ids.push(d.id);
                    }
                }
            }
        }
        return [...new Set(ids)];
    }

    escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

module.exports = BacklinkToListPlugin;
module.exports.default = BacklinkToListPlugin;