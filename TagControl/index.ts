import { IInputs, IOutputs } from "./generated/ManifestTypes";

interface TagControlConfig {
    tag: {
        table: string;       // e.g. "new_tag"
        nameColumn: string;  // e.g. "new_name"
    };
    // If omitted, the control works in TEXT-ONLY mode: tags are stored only in the bound
    // text column and never synchronized with Dataverse (no Tag/Bridge tables needed).
    bridge?: {
        table: string;       // e.g. "new_target_new_tag"
        targetLookup: string;// lookup column on bridge pointing to target table
        tagLookup: string;   // lookup column on bridge pointing to tag table
    };
    options?: {
        delimiter?: string;               // default ";"
        caseInsensitive?: boolean;        // default true
        maxTags?: number;                 // default 50
        syncTextToDataverseOnSave?: boolean; // default true
    };
}

interface TagItem {
    name: string;        // display name
    tagId?: string;      // tag record id (GUID without braces)
    bridgeId?: string;   // bridge record id (GUID without braces)
}

const PrivilegeType = {
    None: 0,
    Create: 1,
    Read: 2,
    Write: 3,
    Delete: 4,
    Assign: 5,
    Share: 6,
    Append: 7,
    AppendTo: 8,
} as const;

const PrivilegeDepth = {
    None: -1,
    Basic: 0,   // User
    Local: 1,   // Business Unit
    Deep: 2,    // Parent:Child BU
    Global: 3,  // Organization
} as const;

const CONFIG_PROPERTIES = [
    "config", "tagTable", "tagNameColumn", "bridgeTable", "bridgeTargetLookup", "bridgeTagLookup",
    "delimiter", "maxTags", "caseInsensitive", "syncTextOnLoad",
];

const DEFAULT_DELIMITER = ";";
const DEFAULT_MAX_TAGS = 50;
const LOGICAL_NAME_RE = /^[a-z][a-z0-9_]*$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface EntityMeta {
    logicalName: string;
    primaryIdAttribute: string;
    entityPluralName: string; // used for @odata.bind paths
}

interface Capabilities {
    fieldReadable: boolean;
    fieldEditable: boolean;

    canReadBridge: boolean;
    canReadTag: boolean;

    canCreateBridge: boolean;
    canDeleteBridge: boolean;

    canCreateTag: boolean;

    canAppendBridge: boolean;
    canAppendToTarget: boolean;
    canAppendToTag: boolean;
}

export class TagControl implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private _context!: ComponentFramework.Context<IInputs>;
    private _notifyOutputChanged!: () => void;

    private _container!: HTMLDivElement;

    private _box!: HTMLDivElement;
    private _message!: HTMLDivElement;
    private _input!: HTMLInputElement;

    private _config?: TagControlConfig;
    private _configError = "";
    private _delimiter = DEFAULT_DELIMITER;

    private _value = "";
    private _tags: TagItem[] = [];

    private _metaCache = new Map<string, EntityMeta>();
    private _caps: Capabilities | null = null;

    private _refreshToken = 0;
    private _busy = false;
    private _recordKey = "";
    private _restoreFocus = false;

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        _state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this._context = context;
        this._notifyOutputChanged = notifyOutputChanged;
        this._container = container;

        // Build root UI
        this._box = document.createElement("div");
        this._box.className = "pcfTagBox";

        this._input = document.createElement("input");
        this._input.type = "text";
        this._input.className = "pcfTagInput";
        this._input.placeholder = "Type a tag and end with ';'";
        this._input.addEventListener("input", () => void this.onInputChanged());
        this._input.addEventListener("keydown", (e) => this.onKeyDown(e));

        this._message = document.createElement("div");
        this._message.className = "pcfTagMessage";

        container.appendChild(this._box);
        container.appendChild(this._message);

        // First render + initial refresh
        this.render();
        void this.refresh();
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        this._context = context;

        const updated = context.updatedProperties ?? [];
        // The record context can change without the inputs changing (e.g. a new record is saved
        // and the host fills the record id): detect it explicitly.
        const recordKey = `${this.getEntityName()}|${this.getEntityId()}`;
        const recordChanged = recordKey !== this._recordKey;
        const shouldRefresh =
            recordChanged ||
            CONFIG_PROPERTIES.some(name => updated.includes(name)) ||
            updated.includes("entityId") ||
            updated.includes("entityName");

        // Text-only mode or unsaved record: when the bound value changes externally,
        // render tags from the text field only.
        const entityId = this.getEntityId();
        if ((this.isTextOnlyMode() || !entityId) && updated.includes("value") && !shouldRefresh) {
            const valueRaw = (context.parameters.value.raw ?? "").toString();
            this._tags = this.parseTagsFromText(valueRaw, this._delimiter);
            this._value = valueRaw;
            this.render();
            return;
        }

        if (shouldRefresh) {
            void this.refresh();
        } else {
            // Update only field security state (server privileges are preserved) and re-render
            this.applyFieldSecurity();
            this.render();
        }
    }

    public getOutputs(): IOutputs {
        return { value: this._value };
    }

    public destroy(): void {
        // Invalidate any in-flight refresh so late responses are ignored
        this._refreshToken++;
        this._busy = false;
        while (this._container.firstChild) this._container.removeChild(this._container.firstChild);
    }

    // ----------------------------
    // UI Events
    // ----------------------------

    private onKeyDown(e: KeyboardEvent): void {
        // Optional: Enter commits current input as one tag
        if (e.key === "Enter") {
            e.preventDefault();
            void this.commitInputAsTags();
        }
    }

    private async onInputChanged(): Promise<void> {
        if (this._busy) return;

        // If user typed/pasted delimiter, process completed tokens
        const val = this._input.value;
        if (!val.includes(this._delimiter)) return;

        const parts = val.split(this._delimiter);
        const completeTokens = parts.slice(0, -1);
        const remainder = parts[parts.length - 1] ?? "";

        this._input.value = remainder;
        this._restoreFocus = true;

        await this.addTags(completeTokens);
    }

    private async commitInputAsTags(): Promise<void> {
        if (this._busy) return;
        const val = this._input.value.trim();
        if (!val) return;

        this._input.value = "";
        this._restoreFocus = true;
        await this.addTags([val]);
    }

    // ----------------------------
    // Core logic
    // ----------------------------

    private async refresh(): Promise<void> {
        const token = ++this._refreshToken;
        this._recordKey = `${this.getEntityName()}|${this.getEntityId()}`;
        this.setMessage("");

        this.parseConfig();
        this._delimiter = this._config?.options?.delimiter ?? DEFAULT_DELIMITER;
        this._input.placeholder = `Type a tag and end with '${this._delimiter}'`;

        // Apply Field Level Security to determine readable/editable behavior
        this.applyFieldSecurity();

        if (!this._config) {
            this.setMessage(this._configError || "Configuration JSON is missing or invalid.");
            this.render();
            return;
        }

        if (!this._caps?.fieldReadable) {
            this.setMessage("Field is not readable (Field Level Security).");
            this.render();
            return;
        }

        // Text-only mode (no "bridge" in config): never touch Dataverse, tags always live in the text column.
        if (this.isTextOnlyMode()) {
            const raw = (this._context.parameters.value.raw ?? "").toString();
            this._tags = this.parseTagsFromText(raw, this._delimiter);
            this._value = raw;
            this.setMessage("");
            this.render();
            return;
        }

        const entityName = this.getEntityName();
        const entityId = this.getEntityId();

        // Unsaved record: keep everything local in the bound text field until the record is saved
        if (!entityId || !entityName) {
            const raw = (this._context.parameters.value.raw ?? "").toString();
            this._tags = this.parseTagsFromText(raw, this._delimiter);
            this._value = raw;
            this.setMessage("Save the record to sync tags to Dataverse (Tag + Bridge tables).");
            this.render();
            return;
        }

        if (!LOGICAL_NAME_RE.test(entityName)) {
            this.setMessage(`Invalid entityName "${entityName}".`);
            this.render();
            return;
        }

        this._busy = true;
        this.setMessage("Loading tags...");
        this.render();

        try {
            // Ensure metadata is cached before privilege checks
            await this.ensureMetadata(entityName, this._config.tag.table, this._config.bridge!.table);
            if (token !== this._refreshToken) return;

            // Compute user capabilities (best-effort gating)
            this._caps = this.computeCapabilities(entityName);

            // Load tags from server (bridge is source of truth when record exists)
            await this.loadTagsFromServer(entityName, entityId);
            if (token !== this._refreshToken) return;

            this._busy = false;

            const raw = (this._context.parameters.value.raw ?? "").toString();
            // Start from the persisted text so an unchanged tag set does not dirty the form on load
            this._value = raw;

            // Optional: if text field has tags that are missing in bridge, create them
            const sync = this._config.options?.syncTextToDataverseOnSave ?? true;
            if (sync && this._caps.canReadBridge && this._caps.canReadTag) {
                const fromText = this.parseTagsFromText(raw, this._delimiter);

                const missing = fromText
                    .map(t => t.name)
                    .filter(n => !this.hasTagName(n));

                if (missing.length > 0) {
                    await this.addTags(missing);
                    if (token !== this._refreshToken) return;
                }
            }

            // Update bound text from server tags only when the tag set actually differs
            if (this.tagSetKey(this.parseTagsFromText(this._value, this._delimiter)) !== this.tagSetKey(this._tags)) {
                this.updateBoundTextFromTags();
            }
            if (!this._message.textContent) this.setMessage("");
        } catch (e: unknown) {
            if (token !== this._refreshToken) return;
            // Fallback: show what we have in the text field so the user is never left with an empty control
            const raw = (this._context.parameters.value.raw ?? "").toString();
            this._tags = this.parseTagsFromText(raw, this._delimiter);
            this.setMessage(this.prettyError(e, "Failed to load tags."));
        } finally {
            if (token === this._refreshToken) {
                this._busy = false;
                this.render();
            }
        }
    }

    private parseConfig(): void {
        this._config = undefined;
        this._configError = "";

        // Optional JSON (bind to a column when longer than the 100-char static value limit of the form designer)
        const raw = (this._context.parameters.config?.raw ?? "").toString().trim();
        let base: Record<string, unknown> = {};
        if (raw) {
            try {
                const json: unknown = JSON.parse(raw);
                if (!json || typeof json !== "object" || Array.isArray(json)) {
                    this._configError = "Invalid configuration: root must be an object.";
                    return;
                }
                base = json as Record<string, unknown>;
            } catch {
                this._configError = "Configuration is not valid JSON.";
                return;
            }
        }

        // Individual properties override the JSON values when set
        const p = this._context.parameters;
        const text = (v: string | null | undefined): string | undefined => {
            const s = (v ?? "").toString().trim();
            return s ? s.toLowerCase() : undefined;
        };
        const merge = (section: unknown, values: Record<string, unknown>): Record<string, unknown> | undefined => {
            const defined = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null));
            const current = section && typeof section === "object" ? section as Record<string, unknown> : undefined;
            if (!current && Object.keys(defined).length === 0) return undefined;
            return { ...(current ?? {}), ...defined };
        };

        const tag = merge(base.tag, { table: text(p.tagTable?.raw), nameColumn: text(p.tagNameColumn?.raw) });
        const bridge = merge(base.bridge, {
            table: text(p.bridgeTable?.raw),
            targetLookup: text(p.bridgeTargetLookup?.raw),
            tagLookup: text(p.bridgeTagLookup?.raw),
        });
        const delimiter = (p.delimiter?.raw ?? "").toString();
        const options = merge(base.options, {
            delimiter: delimiter ? delimiter : undefined,
            maxTags: typeof p.maxTags?.raw === "number" ? p.maxTags.raw : undefined,
            caseInsensitive: typeof p.caseInsensitive?.raw === "boolean" ? p.caseInsensitive.raw : undefined,
            syncTextToDataverseOnSave: typeof p.syncTextOnLoad?.raw === "boolean" ? p.syncTextOnLoad.raw : undefined,
        });

        if (!tag) {
            this._configError = "Configuration missing: set \"Tag table\" and \"Tag name column\" (or the Configuration JSON).";
            return;
        }

        const parsed: Record<string, unknown> = { ...base, tag };
        if (bridge) parsed.bridge = bridge; else delete parsed.bridge;
        if (options) parsed.options = options;

        const error = this.validateConfig(parsed);
        if (error) {
            this._configError = `Invalid configuration: ${error}`;
            return;
        }

        this._config = parsed as unknown as TagControlConfig;
    }

    private validateConfig(cfg: unknown): string {
        if (!cfg || typeof cfg !== "object") return "root must be an object.";
        const c = cfg as Partial<TagControlConfig>;

        const required: [string, unknown][] = [
            ["tag.table", c.tag?.table],
            ["tag.nameColumn", c.tag?.nameColumn],
        ];

        // "bridge" is optional: when omitted the control runs in text-only mode.
        if (c.bridge !== undefined) {
            if (typeof c.bridge !== "object" || c.bridge === null) return "\"bridge\" must be an object.";
            required.push(
                ["bridge.table", c.bridge.table],
                ["bridge.targetLookup", c.bridge.targetLookup],
                ["bridge.tagLookup", c.bridge.tagLookup],
            );
        }

        for (const [path, value] of required) {
            if (typeof value !== "string" || !value.trim()) return `"${path}" is required.`;
            if (!LOGICAL_NAME_RE.test(value.trim())) return `"${path}" must be a valid Dataverse logical name (lowercase, e.g. "new_tag").`;
        }

        const opt = c.options;
        if (opt !== undefined) {
            if (typeof opt !== "object" || opt === null) return "\"options\" must be an object.";
            if (opt.delimiter !== undefined && (typeof opt.delimiter !== "string" || opt.delimiter.length === 0)) {
                return "\"options.delimiter\" must be a non-empty string.";
            }
            if (opt.maxTags !== undefined && (typeof opt.maxTags !== "number" || !Number.isInteger(opt.maxTags) || opt.maxTags < 1)) {
                return "\"options.maxTags\" must be a positive integer.";
            }
            if (opt.caseInsensitive !== undefined && typeof opt.caseInsensitive !== "boolean") {
                return "\"options.caseInsensitive\" must be a boolean.";
            }
            if (opt.syncTextToDataverseOnSave !== undefined && typeof opt.syncTextToDataverseOnSave !== "boolean") {
                return "\"options.syncTextToDataverseOnSave\" must be a boolean.";
            }
        }

        return "";
    }

    private applyFieldSecurity(): void {
        const sec = this._context.parameters.value.security;
        const fieldReadable = sec ? sec.readable : true;
        const fieldEditable = (sec ? sec.editable : true) && !this._context.mode.isControlDisabled;

        // Merge field-level info; preserve server privileges already computed (if any)
        this._caps = {
            canReadBridge: false,
            canReadTag: false,
            canCreateBridge: false,
            canDeleteBridge: false,
            canCreateTag: false,
            canAppendBridge: false,
            canAppendToTarget: false,
            canAppendToTag: false,
            ...(this._caps ?? {}),
            fieldReadable,
            fieldEditable,
        };
    }

    private async ensureMetadata(targetEntity: string, tagEntity: string, bridgeEntity: string): Promise<void> {
        // context.utils.getEntityMetadata returns EntityMetadata, which includes:
        // logicalName, primaryIdAttribute, entityPluralName, ...
        const needed = [targetEntity, tagEntity, bridgeEntity];

        for (const logical of needed) {
            if (this._metaCache.has(logical)) continue;

            let md: ComponentFramework.PropertyHelper.EntityMetadata;
            try {
                md = await this._context.utils.getEntityMetadata(logical);
            } catch (e: unknown) {
                throw new Error(`Table "${logical}" not found or not accessible. Check the config JSON. (${this.prettyError(e, "metadata error")})`);
            }

            if (!md?.PrimaryIdAttribute || !md?.EntitySetName) {
                throw new Error(`Incomplete metadata returned for table "${logical}".`);
            }

            this._metaCache.set(logical, {
                logicalName: md.LogicalName ?? logical,
                primaryIdAttribute: md.PrimaryIdAttribute,
                entityPluralName: md.EntitySetName,
            });
        }
    }

    /** True when the JSON config has no "bridge" section: tags stay only in the bound text column. */
    private isTextOnlyMode(): boolean {
        return !this._config?.bridge;
    }

    private computeCapabilities(targetEntity: string): Capabilities {
        const cfg = this._config!;
        const bridgeTable = cfg.bridge?.table ?? "";
        const tagTable = cfg.tag.table;

        // Helper: true if user has given privilege at any depth.
        // Some hosts (e.g. custom pages / test harness) may not implement hasEntityPrivilege:
        // in that case we optimistically allow and let the server enforce security.
        const hasAnyDepth = (entity: string, priv: ComponentFramework.PropertyHelper.Types.PrivilegeType): boolean => {
            const depths: ComponentFramework.PropertyHelper.Types.PrivilegeDepth[] = [PrivilegeDepth.Global, PrivilegeDepth.Deep, PrivilegeDepth.Local, PrivilegeDepth.Basic];
            try {
                if (typeof this._context.utils.hasEntityPrivilege !== "function") return true;
                return depths.some(d => this._context.utils.hasEntityPrivilege(entity, priv, d));
            } catch {
                return true;
            }
        };

        const fieldReadable = this._caps?.fieldReadable ?? true;
        const fieldEditable = this._caps?.fieldEditable ?? true;

        const canReadBridge = bridgeTable ? hasAnyDepth(bridgeTable, PrivilegeType.Read) : false;
        const canReadTag = hasAnyDepth(tagTable, PrivilegeType.Read);

        const canCreateBridge = bridgeTable ? hasAnyDepth(bridgeTable, PrivilegeType.Create) : false;
        const canDeleteBridge = bridgeTable ? hasAnyDepth(bridgeTable, PrivilegeType.Delete) : false;

        const canCreateTag = hasAnyDepth(tagTable, PrivilegeType.Create);

        // Often needed for relationships/lookup binding scenarios
        const canAppendBridge = bridgeTable ? hasAnyDepth(bridgeTable, PrivilegeType.Append) : false;
        const canAppendToTarget = hasAnyDepth(targetEntity, PrivilegeType.AppendTo);
        const canAppendToTag = hasAnyDepth(tagTable, PrivilegeType.AppendTo);

        return {
            fieldReadable,
            fieldEditable,
            canReadBridge,
            canReadTag,
            canCreateBridge,
            canDeleteBridge,
            canCreateTag,
            canAppendBridge,
            canAppendToTarget,
            canAppendToTag,
        };
    }

    private async addTags(rawTokens: string[]): Promise<void> {
        const cfg = this._config;
        if (!cfg) return;
        if (this._busy) return;

        const entityName = this.getEntityName();
        const entityId = this.getEntityId();

        const tokens = rawTokens
            .map(t => this.normalizeTagName(t))
            .filter(t => !!t);

        if (tokens.length === 0) return;

        // Local dedup
        const unique = tokens.filter(n => !this.hasTagName(n));
        if (unique.length === 0) return;

        // Max tags check
        const maxTags = cfg.options?.maxTags ?? DEFAULT_MAX_TAGS;
        if (this._tags.length + unique.length > maxTags) {
            this.setMessage(`Maximum number of tags reached: ${maxTags}.`);
            return;
        }

        // Text-only mode or unsaved record -> store only in text field
        if (this.isTextOnlyMode() || !entityId || !entityName) {
            for (const n of unique) this._tags.push({ name: n });
            this.updateBoundTextFromTags();
            this.render();
            return;
        }

        // Capability gating (best-effort)
        const caps = this._caps;
        if (!caps?.fieldEditable) {
            this.setMessage("Field is not editable.");
            return;
        }
        if (!caps.canCreateBridge) {
            this.setMessage("You don't have privileges to create bridge records.");
            return;
        }
        if (!caps.canReadTag) {
            this.setMessage("You don't have read privileges on the Tag table; duplicate prevention is not possible.");
            return;
        }

        this._busy = true;
        this.setMessage("Saving tags...");
        this.render();

        try {
            for (const name of unique) {
                // 1) Find or create tag
                const tag = await this.findOrCreateTag(name);

                // 2) Ensure bridge exists
                await this.ensureBridge(entityName, entityId, tag.id);
            }

            // 3) Reload and update bound field
            await this.loadTagsFromServer(entityName, entityId);
            this.updateBoundTextFromTags();
            this.setMessage("");
        } catch (e: unknown) {
            this.setMessage(this.prettyError(e, "Failed to create tags."));
        } finally {
            this._busy = false;
            this.render();
        }

        // Tags typed while saving are processed now
        if (this._input.value.includes(this._delimiter)) await this.onInputChanged();
    }

    private async removeTag(tag: TagItem): Promise<void> {
        const cfg = this._config;
        if (!cfg) return;
        if (this._busy) return;

        const entityName = this.getEntityName();
        const entityId = this.getEntityId();

        // Text-only mode or unsaved record -> remove locally
        if (this.isTextOnlyMode() || !entityId || !entityName) {
            const key = this.normalizeKey(tag.name);
            this._tags = this._tags.filter(t => this.normalizeKey(t.name) !== key);
            this.updateBoundTextFromTags();
            this.render();
            return;
        }

        if (!tag.bridgeId) {
            // If bridge id is missing, reload from server
            try {
                await this.loadTagsFromServer(entityName, entityId);
            } catch (e: unknown) {
                this.setMessage(this.prettyError(e, "Failed to load tags."));
            }
            this.render();
            return;
        }

        const caps = this._caps;
        if (!caps?.fieldEditable) {
            this.setMessage("Field is not editable.");
            return;
        }
        if (!caps.canDeleteBridge) {
            this.setMessage("You don't have privileges to delete bridge records.");
            return;
        }

        this._busy = true;
        this.setMessage("Removing tag...");
        this.render();

        try {
            await this._context.webAPI.deleteRecord(cfg.bridge!.table, tag.bridgeId);
            await this.loadTagsFromServer(entityName, entityId);
            this.updateBoundTextFromTags();
            this.setMessage("");
        } catch (e: unknown) {
            this.setMessage(this.prettyError(e, "Failed to remove tag."));
        } finally {
            this._busy = false;
            this.render();
        }
    }

    private async loadTagsFromServer(targetEntity: string, targetId: string): Promise<void> {
        const cfg = this._config!;
        const caps = this._caps;

        // If user cannot read bridge/tag, fallback to bound text field
        if (!caps?.canReadBridge || !caps.canReadTag) {
            const raw = (this._context.parameters.value.raw ?? "").toString();
            this._tags = this.parseTagsFromText(raw, this._delimiter);
            this.setMessage("Insufficient privileges to read tags from Dataverse. Showing tags from the text field.");
            return;
        }

        const bridge = cfg.bridge!;
        const bridgeMeta = this._metaCache.get(bridge.table);
        const tagMeta = this._metaCache.get(cfg.tag.table);
        if (!bridgeMeta || !tagMeta) throw new Error("Metadata not loaded.");

        // FetchXML to read bridge + joined tag name
        const fetchXml =
            `?fetchXml=<fetch distinct='true' mapping='logical'>` +
            `<entity name='${bridge.table}'>` +
            `<attribute name='${bridgeMeta.primaryIdAttribute}' alias='bridgeid' />` +
            `<filter>` +
            `<condition attribute='${bridge.targetLookup}' operator='eq' value='${targetId}' />` +
            `</filter>` +
            `<link-entity name='${cfg.tag.table}' from='${tagMeta.primaryIdAttribute}' to='${bridge.tagLookup}' alias='t'>` +
            `<attribute name='${tagMeta.primaryIdAttribute}' alias='tagid' />` +
            `<attribute name='${cfg.tag.nameColumn}' alias='tagname' />` +
            `</link-entity>` +
            `</entity>` +
            `</fetch>`;

        const res = await this._context.webAPI.retrieveMultipleRecords(bridge.table, this.fetchQuery(fetchXml));

        const items: TagItem[] = (res.entities || [])
            .map((e: ComponentFramework.WebApi.Entity) => {
                const name = (e["tagname"] ?? "").toString();
                const tagId = this.sanitizeGuid(e["tagid"]);
                const bridgeId = this.sanitizeGuid(e["bridgeid"]);
                return { name, tagId, bridgeId };
            })
            .filter(t => !!t.name);

        // Deduplicate by normalized name
        const seen = new Set<string>();
        const cleaned: TagItem[] = [];
        for (const t of items) {
            const k = this.normalizeKey(t.name);
            if (seen.has(k)) continue;
            seen.add(k);
            cleaned.push(t);
        }

        // Optional: sort alphabetically
        cleaned.sort((a, b) => a.name.localeCompare(b.name));
        this._tags = cleaned;
    }

    private async findOrCreateTag(name: string): Promise<{ id: string; name: string }> {
        const cfg = this._config!;
        const tagMeta = this._metaCache.get(cfg.tag.table);
        if (!tagMeta) throw new Error("Metadata not loaded.");

        // Try find existing by name (value is URL-encoded so names like "R&D" or "C#" work)
        const escaped = encodeURIComponent(this.escapeODataString(name));
        const query = `?$select=${tagMeta.primaryIdAttribute},${cfg.tag.nameColumn}&$filter=${cfg.tag.nameColumn} eq '${escaped}'&$top=1`;

        const found = await this._context.webAPI.retrieveMultipleRecords(cfg.tag.table, query);

        if (found.entities && found.entities.length > 0) {
            const rec = found.entities[0];
            const id = this.sanitizeGuid(rec[tagMeta.primaryIdAttribute]);
            if (!id) throw new Error(`Tag "${name}" was found but has no valid id.`);
            return {
                id,
                name: (rec[cfg.tag.nameColumn] ?? name).toString(),
            };
        }

        // Create if not found
        const caps = this._caps;
        if (!caps?.canCreateTag) {
            throw new Error(`Tag "${name}" does not exist and you don't have privileges to create it.`);
        }

        const createRes = await this._context.webAPI.createRecord(cfg.tag.table, {
            [cfg.tag.nameColumn]: name,
        });

        const newId = this.sanitizeGuid(createRes.id);
        if (!newId) throw new Error(`Tag "${name}" was created but no id was returned.`);
        return { id: newId, name };
    }

    private async ensureBridge(targetEntity: string, targetId: string, tagId: string): Promise<void> {
        const cfg = this._config!;
        const bridge = cfg.bridge!;
        const bridgeMeta = this._metaCache.get(bridge.table);
        const targetMeta = this._metaCache.get(targetEntity);
        const tagMeta = this._metaCache.get(cfg.tag.table);
        if (!bridgeMeta || !targetMeta || !tagMeta) throw new Error("Metadata not loaded.");

        // 1) Check if bridge already exists (avoid duplicates)
        const fetch =
            `?fetchXml=<fetch top='1' mapping='logical'>` +
            `<entity name='${bridge.table}'>` +
            `<attribute name='${bridgeMeta.primaryIdAttribute}' alias='bridgeid' />` +
            `<filter>` +
            `<condition attribute='${bridge.targetLookup}' operator='eq' value='${targetId}' />` +
            `<condition attribute='${bridge.tagLookup}' operator='eq' value='${tagId}' />` +
            `</filter>` +
            `</entity>` +
            `</fetch>`;

        const existing = await this._context.webAPI.retrieveMultipleRecords(bridge.table, this.fetchQuery(fetch));
        if (existing.entities && existing.entities.length > 0) return;

        // 2) Create bridge record using @odata.bind
        const payload: Record<string, string> = {};
        payload[`${bridge.targetLookup}@odata.bind`] = `/${targetMeta.entityPluralName}(${targetId})`;
        payload[`${bridge.tagLookup}@odata.bind`] = `/${tagMeta.entityPluralName}(${tagId})`;

        await this._context.webAPI.createRecord(bridge.table, payload);
    }

    // ----------------------------
    // Rendering
    // ----------------------------

    private render(): void {
        const hadFocus = document.activeElement === this._input;

        // Clear chips but keep the input element in place so it does not lose focus
        for (const child of Array.from(this._box.childNodes)) {
            if (child !== this._input) this._box.removeChild(child);
        }

        const caps = this._caps;
        const editable = !!caps?.fieldEditable && !this._busy;

        // Render chips
        for (const tag of this._tags) {
            const chip = document.createElement("span");
            chip.className = "pcfTagChip";

            const text = document.createElement("span");
            text.className = "pcfTagChipText";
            text.textContent = tag.name;

            chip.appendChild(text);

            // Remove button
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "pcfTagChipRemove";
            btn.textContent = "\u00D7";
            btn.title = "Remove tag";
            btn.setAttribute("aria-label", `Remove tag ${tag.name}`);

            const canRemove = editable && (this.isTextOnlyMode() || !!caps?.canDeleteBridge);
            btn.disabled = !canRemove;

            btn.addEventListener("click", () => void this.removeTag(tag));

            chip.appendChild(btn);
            this._box.insertBefore(chip, this._input.parentNode === this._box ? this._input : null);
        }

        // Render input. While saving it stays in the DOM as read-only (disabling or detaching it drops the focus).
        if (this.canShowInput()) {
            if (this._input.parentNode !== this._box) this._box.appendChild(this._input);
            this._input.disabled = false;
            this._input.readOnly = false;

            const active = document.activeElement;
            const focusIsFree = !active || active === document.body || active === this._input;
            if ((hadFocus || this._restoreFocus) && focusIsFree) {
                if (active !== this._input) this._input.focus();
                if (!this._busy) this._restoreFocus = false;
            }
        } else {
            if (this._input.parentNode === this._box) this._box.removeChild(this._input);
            this._input.disabled = true;
            this._restoreFocus = false;
        }
    }

    private canShowInput(): boolean {
        const caps = this._caps;
        if (!caps?.fieldEditable) return false;

        // Text-only mode: no Dataverse privileges needed to add tags
        if (this.isTextOnlyMode()) return true;

        // To add tags we need at least create bridge + read tag
        if (!caps.canCreateBridge) return false;
        if (!caps.canReadTag) return false;

        return true;
    }

    private setMessage(msg: string): void {
        this._message.textContent = msg;
    }

    private updateBoundTextFromTags(): void {
        // Store clean values in the bound text field (no UI symbols)
        const next = this._tags.map(t => t.name).join(this._delimiter);
        if (next === this._value) return;
        this._value = next;
        this._notifyOutputChanged();
    }

    // ----------------------------
    // Helpers
    // ----------------------------

    /** Logical name of the host table: explicit input first, otherwise the form context. */
    private getEntityName(): string {
        const explicit = (this._context.parameters.entityName?.raw ?? "").toString().trim().toLowerCase();
        if (explicit) return explicit;
        const info = (this._context.mode as unknown as { contextInfo?: { entityTypeName?: string } }).contextInfo;
        return (info?.entityTypeName ?? "").toString().trim().toLowerCase();
    }

    /** Record GUID: explicit input first, otherwise the form context (empty for unsaved records). */
    private getEntityId(): string {
        const explicit = this.sanitizeGuid(this._context.parameters.entityId?.raw);
        if (explicit) return explicit;
        const info = (this._context.mode as unknown as { contextInfo?: { entityId?: string } }).contextInfo;
        return this.sanitizeGuid(info?.entityId);
    }

    /** Wraps a FetchXML document into a URL-encoded Web API query string. */
    private fetchQuery(fetchXml: string): string {
        return `?fetchXml=${encodeURIComponent(fetchXml.replace(/^\?fetchXml=/, ""))}`;
    }

    /** Order-independent key of a tag list, used to avoid rewriting an equivalent text value. */
    private tagSetKey(tags: TagItem[]): string {
        return tags.map(t => this.normalizeKey(t.name)).sort().join("\u0000");
    }

    private parseTagsFromText(raw: string, delimiter: string): TagItem[] {
        const parts = raw
            .split(delimiter)
            .map(s => this.normalizeTagName(s))
            .filter(s => !!s);

        const seen = new Set<string>();
        const res: TagItem[] = [];

        for (const p of parts) {
            const k = this.normalizeKey(p);
            if (seen.has(k)) continue;
            seen.add(k);
            res.push({ name: p });
        }
        return res;
    }

    private normalizeTagName(s: string): string {
        const trimmed = (s ?? "").toString().split(this._delimiter).join("").replace(/\s+/g, " ").trim();
        if (!trimmed) return "";
        return trimmed;
    }

    private normalizeKey(name: string): string {
        const ci = this._config?.options?.caseInsensitive ?? true;
        return ci ? name.toLowerCase() : name;
    }

    private hasTagName(name: string): boolean {
        const key = this.normalizeKey(name);
        return this._tags.some(t => this.normalizeKey(t.name) === key);
    }

    private escapeODataString(s: string): string {
        // OData string literal escape: ' -> ''
        return s.replace(/'/g, "''");
    }

    private sanitizeGuid(v: unknown): string {
        if (v === null || v === undefined) return "";
        const s = String(v).trim().replace(/[{}]/g, "").toLowerCase();
        return GUID_RE.test(s) ? s : "";
    }

    private prettyError(e: unknown, fallback: string): string {
        if (!e) return fallback;
        if (typeof e === "string") return e;
        if (e instanceof Error) return e.message || fallback;
        if (typeof e === "object") {
            // Dataverse WebAPI errors are plain objects: { message, errorCode, ... }
            const obj = e as { message?: unknown; errorCode?: unknown };
            if (typeof obj.message === "string" && obj.message) {
                return obj.errorCode !== undefined ? `${obj.message} (code ${String(obj.errorCode)})` : obj.message;
            }
        }
        try { return JSON.stringify(e); } catch { return fallback; }
    }
}
