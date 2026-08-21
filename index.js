"use strict";

const { Plugin, showMessage, Menu, fetchSyncPost, Dialog } = require("siyuan");

const STATE_KEY = "state-v3";
const SETTINGS_KEY = "settings-v3";

const DEFAULT_SETTINGS = {
    displayMode: "popover",
    backlinkFormat: "text",
    contentFormat: "text",
    showCurrentDocTitle: true,
    listType: "ordered",
    itemTemplate: "${doc} - ${content}",
    groupBy: "none",
    sortBy: "created_desc",
    dateFilter: "all",
};

class BacklinkToListPlugin extends Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData(SETTINGS_KEY));

        const btn = this.addTopBar({
            icon: "iconLink",
            title: "整理反链列表",
            position: "right",
            callback: (ev) => this.handleTopBarClick(ev),
        });

        if (btn) {
            btn.addEventListener("contextmenu", (ev) => {
                ev.preventDefault();
                const menu = new Menu();
                menu.addItem({
                    icon: "iconSettings",
                    label: "插件设置",
                    click: () => this.openSettingsDialog(),
                });
                menu.open({ x: ev.clientX, y: ev.clientY });
            });
        }

        this.addCommand({
            langKey: "generateBacklinkList",
            langText: "整理反链列表（打开选择面板）",
            callback: () => {
                const topBtn = document.querySelector(`.toolbar__item[data-id="${this.name}"]`);
                this.handleTopBarClick({ target: topBtn });
            },
        });
    }

    handleTopBarClick(event) {
        if (this.settings.displayMode === "dialog") {
            this.openBacklinkDialog();
        } else {
            this.openBacklinkPopover(event);
        }
    }

    /* ==================== 块属性 (Attribute) 标记与匹配算法 ==================== */

    // 历史零宽字符编码（仅用于兼容旧版标记）
    encodeZwId(id) {
        if (!id) return "";
        let zw = "\u200B\u200D";
        for (let i = 0; i < id.length; i++) {
            const code = id.charCodeAt(i);
            for (let b = 7; b >= 0; b--) {
                zw += ((code >> b) & 1) === 1 ? "\u200C" : "\u200B";
            }
        }
        zw += "\u200D\u200B";
        return zw;
    }

    // 检查文本/Kramdown 中是否存在指定块属性标记（含历史标记兼容）
    hasBlockAttr(text, id) {
        if (!text || !id) return false;
        // 检查思源原生块属性标记
        if (text.includes(`custom-b2l="${id}"`) || text.includes(`custom-b2l='${id}'`)) return true;
        // 兼容历史 HTML 标记与属性格式
        if (text.includes(`b2l="${id}"`) || text.includes(`<!-- b2l:${id} -->`)) return true;
        // 兼容历史零宽字符标记
        const zwTag = this.encodeZwId(id);
        return zwTag ? text.includes(zwTag) : false;
    }

    /* ==================== 辅助与安全函数 ==================== */

    async safeSqlQuery(stmt, params = []) {
        let sql = stmt;
        if (Array.isArray(params) && params.length > 0) {
            let i = 0;
            sql = stmt.replace(/\?/g, () => {
                const val = params[i++];
                if (val === null || val === undefined) return "NULL";
                if (typeof val === "number") return String(val);
                return "'" + String(val).replace(/'/g, "''") + "'";
            });
        }
        const res = await fetchSyncPost("/api/query/sql", { stmt: sql });
        if (res && res.code === 0) {
            return res.data || [];
        }
        console.warn("[反链整理] SQL 查询失败:", sql, res);
        return [];
    }

    getLocalTimestampStr(date) {
        const pad = (n) => n.toString().padStart(2, "0");
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }

    escapeMarkdown(text) {
        if (!text) return "";
        return String(text).replace(/([\\`*_{}\[\]()#+\-.!$])/g, "\\$1");
    }

    escapeHtml(str) {
        if (!str) return "";
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    formatTime(timeStr) {
        if (!timeStr || timeStr.length < 14) return "";
        return `${timeStr.substring(0, 4)}-${timeStr.substring(4, 6)}-${timeStr.substring(6, 8)} ${timeStr.substring(8, 10)}:${timeStr.substring(10, 12)}`;
    }

    /* ==================== 面板构建与分帧渲染 ==================== */

    async createPanelElement({ docId, backlinks, titleMap, notebookMap, currentDocTitle, docState, defIds, currentBlockId, onClose }) {
        const hasHistory = !!docState.lastGeneratedBlockId;
        const cleanupFns = [];

        const allItems = backlinks.map((bl) => ({
            bl,
            docTitle: titleMap[bl.root_id] || "未命名文档",
            notebookName: notebookMap[bl.box] || "默认笔记本",
            plainText: this.toPlainText(bl.markdown || bl.content || "", docId, currentDocTitle, this.settings.showCurrentDocTitle, defIds),
            isInserted: !!docState.processed[bl.id],
        }));

        const selectedSet = new Set();
        allItems.forEach((i) => selectedSet.add(i.bl.id));

        const container = document.createElement("div");
        container.className = "b2l-panel-root";
        container.style.cssText = "display: flex; flex-direction: column; gap: 10px; font-size: 12px; box-sizing: border-box;";

        container.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--b3-theme-surface-lighter); padding-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-weight: bold; font-size: 13px;">🔗 整理反链</span>
                    <span id="b2l-count-tag" class="b3-chip b3-chip--small">共 ${backlinks.length} 条</span>
                </div>
                <button id="b2l-open-settings" class="b3-button b3-button--outline" style="padding: 2px 8px; font-size: 11px;">⚙️ 设置</button>
            </div>

            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                <input id="b2l-search" class="b3-text-field" placeholder="搜索关键词..." style="flex: 1; min-width: 120px; font-size: 11px; padding: 4px 6px;" />
                <select id="b2l-filter-date" class="b3-select" style="font-size: 11px; padding: 2px 4px;">
                    <option value="all" ${this.settings.dateFilter === "all" ? "selected" : ""}>全部时间</option>
                    <option value="7d" ${this.settings.dateFilter === "7d" ? "selected" : ""}>近 7 天</option>
                    <option value="30d" ${this.settings.dateFilter === "30d" ? "selected" : ""}>近 30 天</option>
                </select>
                <select id="b2l-sort" class="b3-select" style="font-size: 11px; padding: 2px 4px;">
                    <option value="created_desc" ${this.settings.sortBy === "created_desc" ? "selected" : ""}>时间 ⬇</option>
                    <option value="created_asc" ${this.settings.sortBy === "created_asc" ? "selected" : ""}>时间 ⬆</option>
                    <option value="title_asc" ${this.settings.sortBy === "title_asc" ? "selected" : ""}>标题 A-Z</option>
                </select>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; background: var(--b3-theme-surface); padding: 4px 8px; border-radius: 4px; border: 1px solid var(--b3-theme-surface-lighter);">
                <span style="color: var(--b3-theme-on-surface); font-size: 11px;">快速选择：</span>
                <div style="display: flex; gap: 4px;">
                    <button id="b2l-btn-uninserted" class="b3-button b3-button--outline" style="padding: 1px 6px; font-size: 11px;">仅未插入</button>
                    <button id="b2l-btn-all" class="b3-button b3-button--outline" style="padding: 1px 6px; font-size: 11px;">全选</button>
                    <button id="b2l-btn-none" class="b3-button b3-button--outline" style="padding: 1px 6px; font-size: 11px;">全不选</button>
                </div>
            </div>

            <div id="b2l-list-container" style="flex: 1; min-height: 180px; max-height: 340px; overflow-y: auto; border: 1px solid var(--b3-theme-surface-lighter); border-radius: 4px; padding: 6px; display: flex; flex-direction: column; gap: 10px;"></div>

            <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px;">
                <div style="display: flex; justify-content: flex-end; gap: 6px; align-items: center;">
                    <button id="b2l-btn-generate" class="b3-button b3-button--outline" style="flex: 1; padding: 5px 0; font-size: 12px; border: 1px solid var(--b3-theme-primary); color: var(--b3-theme-primary); font-weight: bold;">➕ 生成新列表</button>
                    <button id="b2l-btn-update" class="b3-button b3-button--outline" style="flex: 1; padding: 5px 0; font-size: 12px; border: 1px solid var(--b3-theme-primary); color: var(--b3-theme-primary); font-weight: bold; ${hasHistory ? "" : "opacity: 0.5;"}">🔄 更新已有列表</button>
                </div>
            </div>
        `;

        let currentFrameId = null;
        const renderChunkedGroup = (targetContainer, items) => {
            targetContainer.innerHTML = "";
            if (items.length === 0) {
                targetContainer.innerHTML = `<div style="font-size: 11px; color: var(--b3-theme-on-surface); padding: 8px; text-align: center;">无匹配项</div>`;
                return;
            }

            const CHUNK_SIZE = 40;
            let index = 0;

            const renderChunk = () => {
                const fragment = document.createDocumentFragment();
                const end = Math.min(index + CHUNK_SIZE, items.length);

                for (; index < end; index++) {
                    const item = items[index];
                    const label = document.createElement("label");
                    label.style.cssText = "display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; background: var(--b3-theme-background); border-radius: 4px; margin-bottom: 4px; cursor: pointer; border: 1px solid var(--b3-theme-surface-lighter);";
                    
                    label.innerHTML = `
                        <input type="checkbox" class="b2l-cb" data-id="${item.bl.id}" ${selectedSet.has(item.bl.id) ? "checked" : ""} style="margin-top: 2px;" />
                        <div style="flex: 1; min-width: 0;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                                <span style="font-size: 11px; font-weight: 600; color: var(--b3-theme-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(item.docTitle)}</span>
                                <span style="font-size: 10px; color: var(--b3-theme-on-surface); opacity: 0.6;">${this.formatTime(item.bl.created).substring(5, 16)}</span>
                            </div>
                            <div style="font-size: 11px; color: var(--b3-theme-on-background); opacity: 0.85; word-break: break-all; line-height: 1.35;">
                                ${this.escapeHtml(item.plainText || "（无关联文本内容）")}
                            </div>
                        </div>
                    `;

                    const cb = label.querySelector(".b2l-cb");
                    const changeHandler = (e) => {
                        if (e.target.checked) selectedSet.add(item.bl.id);
                        else selectedSet.delete(item.bl.id);
                    };
                    cb.addEventListener("change", changeHandler);
                    cleanupFns.push(() => cb.removeEventListener("change", changeHandler));

                    fragment.appendChild(label);
                }

                targetContainer.appendChild(fragment);

                if (index < items.length) {
                    currentFrameId = requestAnimationFrame(renderChunk);
                }
            };

            renderChunk();
        };

        const renderList = () => {
            if (currentFrameId) cancelAnimationFrame(currentFrameId);

            const searchText = container.querySelector("#b2l-search").value;
            const dateFilter = container.querySelector("#b2l-filter-date").value;
            const sortBy = container.querySelector("#b2l-sort").value;

            const filtered = this.filterAndSortItems(allItems, searchText, dateFilter, sortBy);
            container.querySelector("#b2l-count-tag").textContent = `显示 ${filtered.length} / 共 ${backlinks.length} 条`;

            const uninserted = filtered.filter((i) => !i.isInserted);
            const inserted = filtered.filter((i) => i.isInserted);

            const listContainer = container.querySelector("#b2l-list-container");
            listContainer.innerHTML = `
                <div>
                    <div style="font-weight: bold; color: var(--b3-theme-primary); margin-bottom: 6px; font-size: 11px;">📌 未插入 (${uninserted.length})</div>
                    <div id="b2l-group-uninserted"></div>
                </div>
                <div>
                    <div style="font-weight: bold; color: var(--b3-theme-on-surface); margin-bottom: 6px; font-size: 11px;">✅ 已插入 (${inserted.length})</div>
                    <div id="b2l-group-inserted"></div>
                </div>
            `;

            renderChunkedGroup(listContainer.querySelector("#b2l-group-uninserted"), uninserted);
            renderChunkedGroup(listContainer.querySelector("#b2l-group-inserted"), inserted);
        };

        renderList();

        const bindElEvent = (selector, event, handler) => {
            const el = container.querySelector(selector);
            if (el) {
                el.addEventListener(event, handler);
                cleanupFns.push(() => el.removeEventListener(event, handler));
            }
        };

        bindElEvent("#b2l-search", "input", renderList);
        bindElEvent("#b2l-filter-date", "change", (e) => {
            this.settings.dateFilter = e.target.value;
            this.saveData(SETTINGS_KEY, this.settings);
            renderList();
        });
        bindElEvent("#b2l-sort", "change", (e) => {
            this.settings.sortBy = e.target.value;
            this.saveData(SETTINGS_KEY, this.settings);
            renderList();
        });

        bindElEvent("#b2l-open-settings", "click", () => {
            this.destroyPanel(cleanupFns, onClose);
            this.openSettingsDialog();
        });

        bindElEvent("#b2l-btn-uninserted", "click", () => {
            selectedSet.clear();
            allItems.forEach((i) => { if (!i.isInserted) selectedSet.add(i.bl.id); });
            renderList();
        });
        bindElEvent("#b2l-btn-all", "click", () => {
            allItems.forEach((i) => selectedSet.add(i.bl.id));
            renderList();
        });
        bindElEvent("#b2l-btn-none", "click", () => {
            selectedSet.clear();
            renderList();
        });

        bindElEvent("#b2l-btn-generate", "click", async () => {
            if (selectedSet.size === 0) {
                showMessage("请至少选择一条反链", 3000, "info");
                return;
            }
            this.destroyPanel(cleanupFns, onClose);
            await this.executeInsert(docId, backlinks, selectedSet, titleMap, notebookMap, currentDocTitle, defIds, currentBlockId, "generate");
        });

        bindElEvent("#b2l-btn-update", "click", async () => {
            if (selectedSet.size === 0) {
                showMessage("请至少选择一条反链", 3000, "info");
                return;
            }
            if (!hasHistory) {
                showMessage("暂无可更新的历史列表，已为您自动在光标/末尾生成", 3000, "info");
            }
            this.destroyPanel(cleanupFns, onClose);
            await this.executeInsert(docId, backlinks, selectedSet, titleMap, notebookMap, currentDocTitle, defIds, currentBlockId, hasHistory ? "update" : "generate");
        });

        return container;
    }

    destroyPanel(cleanupFns, onClose) {
        if (Array.isArray(cleanupFns)) {
            cleanupFns.forEach((fn) => { try { fn(); } catch (e) {} });
        }
        if (typeof onClose === "function") onClose();
    }

    async openBacklinkPopover(event) {
        const data = await this.prepareBacklinkData();
        if (!data.docId) return;

        const menu = new Menu("b2l-popover-menu");
        const panelEl = await this.createPanelElement({ ...data, onClose: () => menu.close() });
        panelEl.style.width = "370px";
        panelEl.style.padding = "10px";
        panelEl.addEventListener("mousedown", (e) => e.stopPropagation());
        panelEl.addEventListener("click", (e) => e.stopPropagation());

        menu.addItem({ element: panelEl });

        const targetEl = event && event.target ? event.target.closest(".toolbar__item, button") || event.target : null;
        if (targetEl) {
            const rect = targetEl.getBoundingClientRect();
            menu.open({ x: rect.right, y: rect.bottom, isSubMenu: false });
        } else {
            menu.open({ x: window.innerWidth - 390, y: 48 });
        }
    }

    async openBacklinkDialog() {
        const data = await this.prepareBacklinkData();
        if (!data.docId) return;

        const dialog = new Dialog({ title: "", content: "", width: "620px" });
        const panelEl = await this.createPanelElement({ ...data, onClose: () => dialog.destroy() });
        panelEl.style.padding = "16px";
        dialog.element.querySelector(".b3-dialog__body").appendChild(panelEl);
    }

    openSettingsDialog() {
        const dialogContent = document.createElement("div");
        dialogContent.style.cssText = "padding: 16px; display: flex; flex-direction: column; gap: 14px; font-size: 12px;";

        dialogContent.innerHTML = `
            <div style="font-weight: bold; font-size: 15px; border-bottom: 1px solid var(--b3-theme-surface-lighter); padding-bottom: 8px;">
                ⚙️ 反链整理插件设置
            </div>

            <div style="background: var(--b3-theme-surface); padding: 10px 12px; border-radius: 6px; border: 1px solid var(--b3-theme-surface-lighter); display: flex; flex-direction: column; gap: 10px;">
                <div style="font-weight: bold; color: var(--b3-theme-primary);">🎨 渲染样式与模板</div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <label style="display: flex; flex-direction: column; gap: 4px;">
                        <span>列表类型：</span>
                        <select id="b2l-set-listType" class="b3-select">
                            <option value="ordered" ${this.settings.listType === "ordered" ? "selected" : ""}>1. 数字列表</option>
                            <option value="unordered" ${this.settings.listType === "unordered" ? "selected" : ""}>• 无序列表</option>
                            <option value="task" ${this.settings.listType === "task" ? "selected" : ""}>☑ 任务列表</option>
                            <option value="blockquote" ${this.settings.listType === "blockquote" ? "selected" : ""}>▍ 引用块</option>
                            <option value="paragraph" ${this.settings.listType === "paragraph" ? "selected" : ""}>¶ 纯文本段落</option>
                        </select>
                    </label>

                    <label style="display: flex; flex-direction: column; gap: 4px;">
                        <span>分组依据：</span>
                        <select id="b2l-set-groupBy" class="b3-select">
                            <option value="none" ${this.settings.groupBy === "none" ? "selected" : ""}>不分组（平铺）</option>
                            <option value="doc" ${this.settings.groupBy === "doc" ? "selected" : ""}>按源文档</option>
                            <option value="notebook" ${this.settings.groupBy === "notebook" ? "selected" : ""}>按笔记本</option>
                        </select>
                    </label>
                </div>

                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span>单条模板：</span>
                        <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                            <button type="button" class="b3-button b3-button--outline b2l-tpl-btn" data-tag="\${doc}" style="padding: 1px 4px; font-size: 10px;">+\${doc}</button>
                            <button type="button" class="b3-button b3-button--outline b2l-tpl-btn" data-tag="\${content}" style="padding: 1px 4px; font-size: 10px;">+\${content}</button>
                            <button type="button" class="b3-button b3-button--outline b2l-tpl-btn" data-tag="\${created}" style="padding: 1px 4px; font-size: 10px;">+\${created}</button>
                            <button type="button" class="b3-button b3-button--outline b2l-tpl-btn" data-tag="\${updated}" style="padding: 1px 4px; font-size: 10px;">+\${updated}</button>
                            <button type="button" class="b3-button b3-button--outline b2l-tpl-btn" data-tag="\${notebook}" style="padding: 1px 4px; font-size: 10px;">+\${notebook}</button>
                            <button type="button" class="b3-button b3-button--outline b2l-tpl-btn" data-tag="\${path}" style="padding: 1px 4px; font-size: 10px;">+\${path}</button>
                        </div>
                    </div>
                    <input id="b2l-set-itemTemplate" class="b3-text-field" value="${this.escapeHtml(this.settings.itemTemplate)}" placeholder="\${doc} - \${content}" style="font-family: monospace;" />
                </div>
            </div>

            <div style="background: var(--b3-theme-surface); padding: 10px 12px; border-radius: 6px; border: 1px solid var(--b3-theme-surface-lighter); display: flex; flex-direction: column; gap: 10px;">
                <div style="font-weight: bold; color: var(--b3-theme-primary);">🔗 引用语法表达</div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <label style="display: flex; flex-direction: column; gap: 4px;">
                        <span>文档 \${doc} 格式：</span>
                        <select id="b2l-set-backlinkFormat" class="b3-select">
                            <option value="text" ${this.settings.backlinkFormat === "text" ? "selected" : ""}>纯文本</option>
                            <option value="block_ref" ${this.settings.backlinkFormat === "block_ref" ? "selected" : ""}>块引用 ((id "标题"))</option>
                            <option value="hyperlink" ${this.settings.backlinkFormat === "hyperlink" ? "selected" : ""}>超链接 [标题](siyuan://)</option>
                        </select>
                    </label>

                    <label style="display: flex; flex-direction: column; gap: 4px;">
                        <span>文本 \${content} 格式：</span>
                        <select id="b2l-set-contentFormat" class="b3-select">
                            <option value="text" ${this.settings.contentFormat === "text" ? "selected" : ""}>纯文本</option>
                            <option value="block_ref" ${this.settings.contentFormat === "block_ref" ? "selected" : ""}>块引用 ((id "文本"))</option>
                            <option value="hyperlink" ${this.settings.contentFormat === "hyperlink" ? "selected" : ""}>超链接 [文本](siyuan://)</option>
                        </select>
                    </label>
                </div>

                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-top: 2px;">
                    <input type="checkbox" id="b2l-set-showDocTitle" ${this.settings.showCurrentDocTitle ? "checked" : ""} />
                    <span>在引用文本中保留当前文档标题的字样</span>
                </label>
            </div>

            <div style="background: var(--b3-theme-surface); padding: 10px 12px; border-radius: 6px; border: 1px solid var(--b3-theme-surface-lighter); display: flex; flex-direction: column; gap: 8px;">
                <div style="font-weight: bold; color: var(--b3-theme-primary);">🖥️ 面板行为</div>
                
                <label style="display: flex; justify-content: space-between; align-items: center;">
                    <span>面板弹出方式：</span>
                    <select id="b2l-set-displayMode" class="b3-select" style="width: 180px;">
                        <option value="popover" ${this.settings.displayMode === "popover" ? "selected" : ""}>气泡菜单（挂载顶栏）</option>
                        <option value="dialog" ${this.settings.displayMode === "dialog" ? "selected" : ""}>居中弹窗 (Dialog)</option>
                    </select>
                </label>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;">
                <button id="b2l-set-cancel" class="b3-button b3-button--cancel">取消</button>
                <button id="b2l-set-save" class="b3-button b3-button--text" style="padding: 4px 16px;">保存配置</button>
            </div>
        `;

        const dialog = new Dialog({ title: "", content: "", width: "500px" });
        dialog.element.querySelector(".b3-dialog__body").appendChild(dialogContent);

        const tplInput = dialogContent.querySelector("#b2l-set-itemTemplate");
        dialogContent.querySelectorAll(".b2l-tpl-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const tag = btn.dataset.tag;
                const start = tplInput.selectionStart || tplInput.value.length;
                const end = tplInput.selectionEnd || tplInput.value.length;
                tplInput.value = tplInput.value.substring(0, start) + tag + tplInput.value.substring(end);
                tplInput.focus();
                tplInput.setSelectionRange(start + tag.length, start + tag.length);
            });
        });

        dialogContent.querySelector("#b2l-set-cancel").addEventListener("click", () => dialog.destroy());
        dialogContent.querySelector("#b2l-set-save").addEventListener("click", async () => {
            this.settings.displayMode = dialogContent.querySelector("#b2l-set-displayMode").value;
            this.settings.listType = dialogContent.querySelector("#b2l-set-listType").value;
            this.settings.groupBy = dialogContent.querySelector("#b2l-set-groupBy").value;
            this.settings.itemTemplate = dialogContent.querySelector("#b2l-set-itemTemplate").value || "${doc} - ${content}";
            this.settings.backlinkFormat = dialogContent.querySelector("#b2l-set-backlinkFormat").value;
            this.settings.contentFormat = dialogContent.querySelector("#b2l-set-contentFormat").value;
            this.settings.showCurrentDocTitle = dialogContent.querySelector("#b2l-set-showDocTitle").checked;

            await this.saveData(SETTINGS_KEY, this.settings);
            showMessage("设置已成功保存", 3000, "info");
            dialog.destroy();
        });
    }

    /* ==================== 核心逻辑与 API 适配 ==================== */

    getCurrentDocId() {
        const activeProtyle = document.querySelector(".layout__wnd--active .protyle:not(.fn__none)") 
            || document.querySelector(".protyle:not(.fn__none)");
        if (activeProtyle) {
            const docEl = activeProtyle.querySelector(".protyle-background[data-node-id]") 
                || activeProtyle.querySelector(".protyle-title[data-node-id]")
                || activeProtyle.querySelector(".protyle-wysiwyg[data-node-id]")
                || activeProtyle.querySelector("[data-node-id]");
            if (docEl) {
                const id = docEl.getAttribute("data-node-id");
                if (id) return id;
            }
        }
        const activeTab = document.querySelector(".item--focus[data-id]") || document.querySelector(".layout-tab-bar .item--focus");
        if (activeTab) {
            const dataId = activeTab.getAttribute("data-id");
            if (dataId) return dataId;
        }
        return null;
    }

    getCurrentBlockId() {
        const activeProtyle = document.querySelector(".layout__wnd--active .protyle:not(.fn__none)") 
            || document.querySelector(".protyle:not(.fn__none)");
        if (!activeProtyle) return null;

        const focusEl = activeProtyle.querySelector(".node-focus[data-node-id]");
        if (focusEl) return focusEl.getAttribute("data-node-id");

        try {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
                let node = sel.getRangeAt(0).startContainer;
                if (node) {
                    const block = node.nodeType === 1 ? node.closest("[data-node-id]") : node.parentElement?.closest("[data-node-id]");
                    if (block && activeProtyle.contains(block)) {
                        const id = block.getAttribute("data-node-id");
                        if (id) return id;
                    }
                }
            }
        } catch (e) {}

        const selectedBlock = activeProtyle.querySelector(".protyle-wysiwyg--select[data-node-id]");
        if (selectedBlock) return selectedBlock.getAttribute("data-node-id");

        return null;
    }

    async resolveDocId(id) {
        if (!id) return null;
        const rows = await this.safeSqlQuery("SELECT id, root_id, type FROM blocks WHERE id = ?", [id]);
        if (rows.length === 0) return null;
        return rows[0].type === "d" ? rows[0].id : rows[0].root_id;
    }

    async getTopLevelContainerId(blockId, docId) {
        let currentId = blockId;
        for (let i = 0; i < 12; i++) {
            const rows = await this.safeSqlQuery(
                "SELECT id, parent_id FROM blocks WHERE id = ? AND root_id = ?",
                [currentId, docId]
            );
            if (rows.length === 0) return blockId;
            const parentId = rows[0].parent_id;
            if (!parentId || parentId === docId) return currentId;
            currentId = parentId;
        }
        return blockId;
    }

    async getNotebookMap() {
        const res = await fetchSyncPost("/api/notebook/lsNotebooks", {});
        const notebooks = (res && res.data && res.data.notebooks) || [];
        const map = {};
        notebooks.forEach((nb) => { map[nb.id] = nb.name; });
        return map;
    }

    async syncProcessedState(docId, state) {
        const docState = state[docId] || { processed: {}, lastGeneratedBlockId: null };
        if (!docState.processed) docState.processed = {};

        if (!docState.lastGeneratedBlockId) {
            docState.processed = {};
        } else {
            const containerRows = await this.safeSqlQuery(
                "SELECT id FROM blocks WHERE id = ? AND root_id = ?",
                [docState.lastGeneratedBlockId, docId]
            );
            if (containerRows.length === 0) {
                docState.processed = {};
                docState.lastGeneratedBlockId = null;
            }
        }

        state[docId] = docState;
        await this.saveData(STATE_KEY, state);
        return docState;
    }

    async reconcileProcessedWithContent(docId, docState, backlinks) {
        if (!docState.lastGeneratedBlockId || !docState.processed || Object.keys(docState.processed).length === 0) {
            return docState;
        }

        const containerId = docState.lastGeneratedBlockId;

        // 直接查 blocks.ial 字段中包含 custom-b2l 的块（setBlockAttrs 写入后立即可见）
        const ialRows = await this.safeSqlQuery(
            "SELECT ial FROM blocks WHERE root_id = ? AND ial LIKE '%custom-b2l%' AND (id = ? OR path LIKE ?)",
            [docId, containerId, "%" + containerId + "/%"]
        );

        let alive = new Set();
        for (const row of ialRows) {
            const m = row.ial && row.ial.match(/custom-b2l="([^"]+)"/);
            if (m) alive.add(m[1]);
        }

        // 回退：查 attributes 表
        if (alive.size === 0) {
            const attrRows = await this.safeSqlQuery(
                "SELECT a.value FROM attributes a JOIN blocks b ON a.block_id = b.id " +
                "WHERE a.name = 'custom-b2l' AND a.root_id = ? AND (b.id = ? OR b.path LIKE ?)",
                [docId, containerId, "%" + containerId + "/%"]
            );
            alive = new Set(attrRows.map(r => r.value));
        }

        // 回退：旧版 Kramdown 标记
        if (alive.size === 0) {
            const res = await fetchSyncPost("/api/block/getBlockKramdown", { id: containerId });
            const kramdownText = (res && res.code === 0 && res.data) ? (res.data.kramdown || "") : "";
            if (!kramdownText) {
                docState.processed = {};
                docState.lastGeneratedBlockId = null;
                return docState;
            }
            const newProcessed = {};
            for (const bl of backlinks) {
                if (docState.processed[bl.id] && this.hasBlockAttr(kramdownText, bl.id)) {
                    newProcessed[bl.id] = docState.processed[bl.id];
                }
            }
            docState.processed = newProcessed;
            return docState;
        }

        const newProcessed = {};
        for (const bl of backlinks) {
            if (docState.processed[bl.id] && alive.has(bl.id)) {
                newProcessed[bl.id] = docState.processed[bl.id];
            }
        }
        docState.processed = newProcessed;
        return docState;
    }

    filterAndSortItems(items, searchText, dateFilter, sortBy) {
        let result = [...items];

        if (dateFilter !== "all") {
            const days = dateFilter === "7d" ? 7 : 30;
            const limitDate = new Date(Date.now() - days * 86400000);
            const limitStr = this.getLocalTimestampStr(limitDate);
            result = result.filter((item) => (item.bl.created || "") >= limitStr);
        }

        if (searchText && searchText.trim() !== "") {
            const q = searchText.trim().toLowerCase();
            result = result.filter(
                (item) => item.docTitle.toLowerCase().includes(q) || item.plainText.toLowerCase().includes(q)
            );
        }

        result.sort((a, b) => {
            if (sortBy === "created_desc") return (b.bl.created || "").localeCompare(a.bl.created || "");
            if (sortBy === "created_asc") return (a.bl.created || "").localeCompare(b.bl.created || "");
            if (sortBy === "title_asc") return a.docTitle.localeCompare(b.docTitle, "zh-CN");
            return 0;
        });

        return result;
    }

    async prepareBacklinkData() {
        const rawId = this.getCurrentDocId();
        const currentBlockId = this.getCurrentBlockId();
        if (!rawId) {
            showMessage("未找到当前文档", 3000, "error");
            return {};
        }
        const docId = await this.resolveDocId(rawId);
        if (!docId) {
            showMessage("获取文档信息失败", 3000, "error");
            return {};
        }

        const state = (await this.loadData(STATE_KEY)) || {};
        const docState = await this.syncProcessedState(docId, state);

        const { backlinks, defIds } = await this.queryBacklinks(docId);
        if (backlinks.length === 0) {
            showMessage("当前文档暂无关联反链", 3000, "info");
            return {};
        }

        const titleMap = await this.queryDocTitles(backlinks);
        const notebookMap = await this.getNotebookMap();

        const tRows = await this.safeSqlQuery("SELECT content FROM blocks WHERE id = ?", [docId]);
        const currentDocTitle = (tRows && tRows[0]) ? tRows[0].content : "";

        await this.reconcileProcessedWithContent(docId, docState, backlinks);
        await this.saveData(STATE_KEY, state);

        return { docId, backlinks, titleMap, notebookMap, currentDocTitle, docState, defIds, currentBlockId };
    }

    async queryBacklinks(docId) {
        const sql =
            "SELECT b.id AS id, b.root_id AS root_id, b.type AS type, b.content AS content, b.markdown AS markdown, " +
            "b.created AS created, b.updated AS updated, b.box AS box, b.path AS path, " +
            "p.id AS parent_id, p.type AS parent_type, p.content AS parent_content, p.markdown AS parent_markdown, " +
            "r.def_block_id AS def_block_id " +
            "FROM blocks b " +
            "LEFT JOIN blocks p ON b.parent_id = p.id " +
            "JOIN refs r ON b.id = r.block_id " +
            "WHERE r.def_block_root_id = ? AND b.root_id != ?";

        const rows = await this.safeSqlQuery(sql, [docId, docId]);
        const defIds = new Set([docId]);
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
                    content: row.content || row.parent_content || "",
                    markdown: row.markdown || row.parent_markdown || "",
                    created: row.created,
                    updated: row.updated,
                    box: row.box,
                    path: row.path,
                    _refBlockId: row.id,
                };
            }
            if (seen.has(eff.id)) continue;
            seen.add(eff.id);
            backlinks.push(eff);
        }
        return { backlinks, defIds };
    }

    async queryDocTitles(backlinks) {
        const rootIds = [...new Set(backlinks.map((b) => b.root_id).filter(Boolean))];
        const titleMap = {};
        if (rootIds.length === 0) return titleMap;

        const placeholders = rootIds.map(() => "?").join(",");
        const titleRows = await this.safeSqlQuery(
            `SELECT id, content FROM blocks WHERE type = 'd' AND id IN (${placeholders})`,
            rootIds
        );
        titleRows.forEach((r) => { titleMap[r.id] = r.content || "未命名文档"; });
        return titleMap;
    }

    async collectChildren(blockId, docId, docTitle, depth, skipId, defIds, visited = new Set()) {
        if (depth > 5 || visited.has(blockId)) return [];
        visited.add(blockId);

        const res = await fetchSyncPost("/api/block/getChildBlocks", { id: blockId });
        const rawChildren = (res && res.data) || [];
        const result = [];

        for (const child of rawChildren) {
            if (skipId && child.id === skipId) continue;

            if (child.type === "l") {
                const subItems = await this.collectChildren(child.id, docId, docTitle, depth, skipId, defIds, visited);
                result.push(...subItems);
                continue;
            }

            if (child.type === "p" || child.type === "h") {
                continue;
            }

            const text = this.toPlainText(child.markdown || child.content || "", docId, docTitle, this.settings.showCurrentDocTitle, defIds);
            const sub = await this.collectChildren(child.id, docId, docTitle, depth + 1, null, defIds, visited);
            if (text || sub.length > 0) {
                result.push({ id: child.id, text, depth, children: sub });
            }
        }
        return result;
    }

    toPlainText(md, docId, docTitle, showCurrentDocTitle, defIds) {
        if (!md) return "";
        let text = String(md);

        text = text.replace(/<!--[\s\S]*?-->/g, "");
        text = text.replace(/\{:\s*[^}]*\}/g, "");
        // 清理可能存在的零宽不可见字符
        text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");

        const refRegex = /\(\(([0-9a-zA-Z_-]+)(?:\s+["'“\u201c\u201d]([\s\S]*?)["'”\u201c\u201d])?\s*\)\)/g;
        text = text.replace(refRegex, (match, id, anchor) => {
            const isCur = id === docId || (defIds && defIds.has(id));
            if (isCur) {
                return showCurrentDocTitle ? ((anchor !== undefined && anchor !== null) ? anchor : (docTitle || "")) : "";
            } else {
                return (anchor !== undefined && anchor !== null) ? anchor : "";
            }
        });

        text = text.replace(/<span\s+[^>]*data-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/span>/gi, (match, id, content) => {
            const isCur = id === docId || (defIds && defIds.has(id));
            const plainAnchor = content.replace(/<[^>]+>/g, "");
            if (isCur) {
                return showCurrentDocTitle ? (plainAnchor || docTitle || "") : "";
            } else {
                return plainAnchor || "";
            }
        });

        text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, target, alias) => alias || target || "");
        text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "");
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
        text = text.replace(/==([\s\S]*?)==/g, "$1");
        text = text.replace(/`([^`]+)`/g, "$1");
        text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
                   .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        text = text.replace(/\s*\n\s*/g, " ");
        text = text.replace(/\(\([^()]*\)\)/g, "");
        text = text.replace(/[ \t]+/g, " ").trim();
        return text;
    }

    formatBacklink(rootId, docTitle, format) {
        if (!docTitle) return "";
        const safe = this.escapeMarkdown(String(docTitle).replace(/"/g, '“').replace(/[\r\n]+/g, " "));
        if (format === "block_ref") return `((${rootId} "${safe}"))`;
        if (format === "hyperlink") return `[${safe}](siyuan://blocks/${rootId})`;
        return safe;
    }

    formatContent(blockId, text, format) {
        if (!text) return "";
        const safe = this.escapeMarkdown(String(text).replace(/"/g, '“').replace(/[\r\n]+/g, " "));
        if (format === "block_ref") return `((${blockId} "${safe}"))`;
        if (format === "hyperlink") return `[${safe}](siyuan://blocks/${blockId})`;
        return safe;
    }

    buildMarkdown(items) {
        const lines = [];
        const listType = this.settings.listType || "ordered";
        const template = this.settings.itemTemplate || "${doc} - ${content}";
        const groupBy = this.settings.groupBy || "none";

        if (groupBy !== "none") {
            const groups = {};
            for (const item of items) {
                const key = groupBy === "doc" ? item.docTitle : (item.notebookName || "默认笔记本");
                if (!groups[key]) groups[key] = [];
                groups[key].push(item);
            }

            for (const gName in groups) {
                lines.push(`* **${this.escapeMarkdown(gName)}**`);
                groups[gName].forEach((item, idx) => {
                    lines.push(this.buildSingleItemLine(item, idx, listType, template, 1));
                    this.appendChildren(lines, item.children, 2, listType);
                });
            }
        } else {
            items.forEach((item, idx) => {
                lines.push(this.buildSingleItemLine(item, idx, listType, template, 0));
                this.appendChildren(lines, item.children, 1, listType);
            });
        }

        return lines.join("\n");
    }

    buildSingleItemLine(item, index, listType, template, depth) {
        const head = template
            .replace(/\$\{doc\}|\$\{docTitle\}/g, () => this.formatBacklink(item.rootId, item.docTitle, this.settings.backlinkFormat))
            .replace(/\$\{content\}/g, () => this.formatContent(item.sourceId, item.text, this.settings.contentFormat))
            .replace(/\$\{created\}/g, () => this.formatTime(item.created))
            .replace(/\$\{updated\}/g, () => this.formatTime(item.updated))
            .replace(/\$\{notebook\}/g, () => this.escapeMarkdown(item.notebookName || ""))
            .replace(/\$\{path\}/g, () => this.escapeMarkdown(item.path || ""))
            .replace(/^[\s\-:\u2014]+|[\s\-:\u2014]+$/g, "").trim();

        const indent = "    ".repeat(depth);
        let prefix = indent;
        if (listType === "ordered") prefix += `${index + 1}. `;
        else if (listType === "unordered") prefix += "* ";
        else if (listType === "task") prefix += "* [ ] ";
        else if (listType === "blockquote") prefix = "> ".repeat(depth + 1);

        return `${prefix}${head}`;
    }

    appendChildren(lines, children, depth, listType) {
        for (const child of children) {
            const formatted = this.formatContent(child.id, child.text, this.settings.contentFormat);
            if (formatted) {
                const indent = "    ".repeat(depth);
                let prefix = indent + "* ";
                if (listType === "task") prefix = indent + "* [ ] ";
                else if (listType === "blockquote") prefix = "> ".repeat(depth + 1);
                else if (listType === "paragraph") prefix = indent;
                
                lines.push(`${prefix}${formatted}`);
            }
            this.appendChildren(lines, child.children, depth + 1, listType);
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

    /**
     * 插入/更新后，通过 doOperations + SQL 精确定位每条反链项对应的块，
     * 然后调用 setBlockAttrs 写入 custom-b2l 自定义属性。
     * 不依赖 getChildBlocks 遍历，不猜测块树结构。
     */
    /** getChildBlocks 包装 */
    async getChildren(blockId) {
        const res = await fetchSyncPost("/api/block/getChildBlocks", { id: blockId });
        return (res && res.data) || [];
    }

    /** 延迟工具 */
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    /**
     * 用 getChildBlocks 递归遍历容器，按文档顺序收集反链项对应的块。
     */
    async collectContentBlocks(containerId, docId, listType, groupBy) {
        const result = [];

        if (listType === "paragraph") {
            // 段落模式：container 是第一段，从文档顶层块中取连续段落
            const topBlocks = await this.getChildren(docId);
            let start = topBlocks.findIndex(b => b.id === containerId);
            if (start === -1) start = 0;
            for (let i = start; i < topBlocks.length; i++) {
                if (topBlocks[i].type === "p") result.push(topBlocks[i]);
                else if (result.length > 0) break;
            }
        } else if (listType === "blockquote") {
            if (groupBy === "none") {
                const kids = await this.getChildren(containerId);
                for (const k of kids) { if (k.type === "p") result.push(k); }
            } else {
                const groups = await this.getChildren(containerId);
                for (const g of groups) {
                    for (const gc of await this.getChildren(g.id)) {
                        if (gc.type === "b") {
                            for (const qc of await this.getChildren(gc.id)) {
                                if (qc.type === "p") result.push(qc);
                            }
                        }
                    }
                }
            }
        } else {
            // 列表类型（ordered / unordered / task）
            if (groupBy === "none") {
                for (const k of await this.getChildren(containerId)) {
                    if (k.type === "i") result.push(k);
                }
            } else {
                // 分组：外层列表 → 分组项 → 内层列表 → 反链项
                for (const g of await this.getChildren(containerId)) {
                    if (g.type !== "i") continue;
                    for (const gc of await this.getChildren(g.id)) {
                        if (gc.type === "l") {
                            for (const li of await this.getChildren(gc.id)) {
                                if (li.type === "i") result.push(li);
                            }
                        }
                    }
                }
            }
        }
        return result;
    }

    /**
     * 插入/更新后，精确定位每条反链项对应的块并写入 custom-b2l 块属性。
     * 优先用 getChildBlocks 遍历（带重试），回退到 doOperations + SQL。
     */
    async tagInsertedItems(containerId, items, docId, insertRes) {
        const mapping = {};
        const listType = this.settings.listType || "ordered";
        const groupBy = this.settings.groupBy || "none";

        try {
            // 1. 用 getChildBlocks 遍历，带重试（防止块尚未提交）
            let contentBlocks = [];
            for (let attempt = 0; attempt < 3; attempt++) {
                contentBlocks = await this.collectContentBlocks(containerId, docId, listType, groupBy);
                if (contentBlocks.length >= items.length) break;
                await this.sleep(150);
            }
            console.log("[反链整理] getChildBlocks 找到", contentBlocks.length, "个内容块，需要", items.length, "个");

            // 2. 回退：用 doOperations + SQL
            if (contentBlocks.length < items.length && insertRes) {
                const fallback = await this.collectBlocksByOps(insertRes, items, docId, listType, groupBy);
                if (fallback.length > contentBlocks.length) contentBlocks = fallback;
                console.log("[反链整理] 回退后找到", contentBlocks.length, "个内容块");
            }

            // 3. 建立映射并写入块属性
            for (let i = 0; i < items.length && i < contentBlocks.length; i++) {
                const blockId = contentBlocks[i].id || contentBlocks[i];
                mapping[items[i].sourceId] = blockId;
                const res = await fetchSyncPost("/api/attr/setBlockAttrs", {
                    id: blockId,
                    attrs: { "custom-b2l": items[i].sourceId },
                });
                if (!res || res.code !== 0) {
                    console.error("[反链整理] setBlockAttrs 失败:", blockId, items[i].sourceId, res);
                }
            }
        } catch (e) {
            console.error("[反链整理] tagInsertedItems 失败", e);
        }
        return mapping;
    }

    /** 回退方案：从 doOperations + SQL 构建块树并收集内容块 */
    async collectBlocksByOps(insertRes, items, docId, listType, groupBy) {
        const result = [];
        try {
            const insertedIds = this.extractBlockIds(insertRes.data);
            if (insertedIds.length === 0) return result;

            const ph = insertedIds.map(() => "?").join(",");
            const rows = await this.safeSqlQuery(
                `SELECT id, type, parent_id, subtype FROM blocks WHERE root_id = ? AND id IN (${ph})`,
                [docId, ...insertedIds]
            );
            if (rows.length === 0) return result;

            const idSet = new Set(insertedIds);
            const childrenMap = {};
            const orderMap = {};
            insertedIds.forEach((id, i) => { orderMap[id] = i; });
            for (const r of rows) {
                const pid = r.parent_id || "";
                if (!childrenMap[pid]) childrenMap[pid] = [];
                childrenMap[pid].push(r);
            }
            for (const pid in childrenMap) {
                childrenMap[pid].sort((a, b) => (orderMap[a.id] ?? 0) - (orderMap[b.id] ?? 0));
            }

            if (listType === "paragraph") {
                return rows.filter(r => r.type === "p" && !idSet.has(r.parent_id))
                    .sort((a, b) => (orderMap[a.id] ?? 0) - (orderMap[b.id] ?? 0));
            } else if (listType === "blockquote") {
                for (const q of rows.filter(r => r.type === "b" && !idSet.has(r.parent_id))) {
                    const kids = (childrenMap[q.id] || []).filter(k => k.type === "p");
                    if (kids.length > 0) result.push(...kids);
                    else result.push(q);
                }
            } else {
                const containers = rows.filter(r => r.type === "l" && !idSet.has(r.parent_id));
                for (const container of containers) {
                    if (groupBy === "none") {
                        result.push(...(childrenMap[container.id] || []).filter(k => k.type === "i"));
                    } else {
                        for (const gi of (childrenMap[container.id] || []).filter(k => k.type === "i")) {
                            for (const il of (childrenMap[gi.id] || []).filter(k => k.type === "l")) {
                                result.push(...(childrenMap[il.id] || []).filter(k => k.type === "i"));
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error("[反链整理] collectBlocksByOps 失败", e);
        }
        return result;
    }

    async executeInsert(docId, allBacklinks, targetIds, titleMap, notebookMap, currentDocTitle, defIds, currentBlockId, action = "generate") {
        try {
            const state = (await this.loadData(STATE_KEY)) || {};
            const docState = state[docId] || { processed: {}, lastGeneratedBlockId: null };

            const targetBacklinks = allBacklinks.filter((b) => targetIds.has(b.id));
            if (targetBacklinks.length === 0) return;

            const items = [];
            for (const bl of targetBacklinks) {
                const docTitle = titleMap[bl.root_id] || "未命名文档";
                const notebookName = notebookMap[bl.box] || "默认笔记本";
                const mainText = this.toPlainText(bl.markdown || bl.content || "", docId, currentDocTitle, this.settings.showCurrentDocTitle, defIds);

                let children = [];
                if (bl.type === "i") {
                    children = await this.collectChildren(bl.id, docId, currentDocTitle, 1, bl._refBlockId || null, defIds);
                }
                items.push({
                    rootId: bl.root_id,
                    sourceId: bl.id,
                    docTitle,
                    notebookName,
                    created: bl.created,
                    updated: bl.updated,
                    path: bl.path,
                    text: mainText,
                    children,
                });
            }

            const md = this.buildMarkdown(items);
            let insertRes = null;
            let targetBlockId = null;

            if (action === "update" && docState.lastGeneratedBlockId) {
                insertRes = await fetchSyncPost("/api/block/updateBlock", { dataType: "markdown", data: md, id: docState.lastGeneratedBlockId });
                if (insertRes && insertRes.code === 0) {
                    targetBlockId = docState.lastGeneratedBlockId;
                } else {
                    action = "generate";
                }
            }

            if (action === "generate") {
                let insertSuccess = false;
                if (currentBlockId && currentBlockId !== docId) {
                    insertRes = await fetchSyncPost("/api/block/insertBlock", { dataType: "markdown", data: md, previousID: currentBlockId });
                    if (insertRes && insertRes.code === 0) {
                        const insertedIds = this.extractBlockIds(insertRes.data);
                        if (insertedIds.length > 0) {
                            targetBlockId = insertedIds[0];
                            insertSuccess = true;
                        }
                    }
                }

                if (!insertSuccess) {
                    insertRes = await fetchSyncPost("/api/block/appendBlock", { dataType: "markdown", data: md, parentID: docId });
                    if (insertRes && insertRes.code === 0) {
                        const insertedIds = this.extractBlockIds(insertRes.data);
                        if (insertedIds.length > 0) {
                            targetBlockId = insertedIds[0];
                        }
                    }
                }
            }

            if (insertRes && insertRes.code === 0 && targetBlockId) {
                targetBlockId = await this.getTopLevelContainerId(targetBlockId, docId);
                docState.lastGeneratedBlockId = targetBlockId;
                // 定位每个反链项块并写入 custom-b2l 块属性
                const mapping = await this.tagInsertedItems(targetBlockId, items, docId, insertRes);
                docState.processed = {};
                for (const bl of targetBacklinks) {
                    docState.processed[bl.id] = mapping[bl.sourceId] || true;
                }
                state[docId] = docState;
                await this.saveData(STATE_KEY, state);
                showMessage("反链列表整理成功", 3000, "info");
            } else {
                showMessage("写入反链列表失败", 3000, "error");
            }
        } catch (e) {
            console.error("执行插入异常", e);
            showMessage("执行插入发生异常", 3000, "error");
        }
    }
}

module.exports = BacklinkToListPlugin;
module.exports.default = BacklinkToListPlugin;