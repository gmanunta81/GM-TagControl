# GM Tag Control (PCF)

A Power Apps Component Framework (PCF) control that turns a plain **text column** into a **tag editor** ("chips"). It can operate in two modes:

- **Bridge mode**: tags are synchronized with two Dataverse tables (a Tag table for unique tags, a Bridge table for record ↔ tag links).
- **Text-only mode**: tags are stored only in the bound text field, with no server-side sync (useful for testing, restricted permissions, or temporary storage).

Tags are typed in an input box; each `;` (configurable) commits a tag. Existing tags are shown as chips with a remove button.

---

## How it works

| Situation | Behaviour |
|---|---|
| Record **not yet saved** (no `entityId`) | Tags live only in the bound text column, separated by the delimiter. |
| Record **saved** + **Bridge mode** | On load the control reads the Bridge table (source of truth), renders the tags and rewrites the text column. Tags present in the text but missing in Dataverse are created (`syncTextToDataverseOnSave`). |
| Record **saved** + **Text-only mode** | Tags remain only in the text field; no Dataverse reads or writes. |
| Add a tag | **Bridge mode**: creates the Tag row (if new), then the Bridge row. **Text-only mode**: updates the text field only. |
| Remove a tag | **Bridge mode**: deletes the Bridge row (Tag row kept for reuse). **Text-only mode**: updates the text field only. |
| Missing privileges | Buttons / input are disabled and a message explains why. If the user cannot read Bridge/Tag, the control falls back to the text column. |
| Field Level Security | Respected via `parameters.value.security` (readable / editable). |

The bound text column always contains a clean, delimiter-separated list of tag names (useful for views, search and Advanced Find).

---

## Control properties

| Property | Type | Usage | Description |
|---|---|---|---|
| `value` | SingleLine.Text | **bound** | Column that stores the delimited tag list. |
| `tagTable` | SingleLine.Text | input | **Tag table** — logical name, e.g. `gm_tag`. |
| `tagNameColumn` | SingleLine.Text | input | **Tag name column**, e.g. `gm_name`. |
| `bridgeTable` | SingleLine.Text | input (optional) | **Bridge table**, e.g. `gm_accounttag`. Leave empty for text-only mode. |
| `bridgeTargetLookup` | SingleLine.Text | input (optional) | **Bridge lookup to record**, e.g. `gm_accountid`. |
| `bridgeTagLookup` | SingleLine.Text | input (optional) | **Bridge lookup to tag**, e.g. `gm_tagid`. |
| `delimiter` | SingleLine.Text | input (optional) | Default `;`. |
| `maxTags` | Whole.None | input (optional) | Default `50` (1..500). |
| `caseInsensitive` | TwoOptions | input (optional) | Default Yes. |
| `syncTextOnLoad` | TwoOptions | input (optional) | Default Yes (Bridge mode only). |
| `config` | SingleLine.Text | input (optional) | Legacy JSON configuration (see below). Individual properties override it. |
| `entityId` | SingleLine.Text | input (optional) | Record GUID override. **Leave empty on model-driven forms**: the control reads the record id from the form context (empty for unsaved records). Never use one static GUID for every record. |
| `entityName` | SingleLine.Text | input (optional) | Logical name of the host table (e.g. `account`). Leave empty to use the form context. |

### Configuration JSON (optional)

> The form designer limits **static** property values to **100 characters**, so a full JSON usually cannot be typed there. Prefer the individual properties above. Use `config` only if bound to a text column, or for short JSON.

```json
{
  "tag":    { "table": "<tag logical name>",    "nameColumn": "<tag primary name column>" },
  "bridge": { "table": "<bridge logical name>", "targetLookup": "<lookup to host table>", "tagLookup": "<lookup to tag table>" },
  "options": {
    "delimiter": ";",
    "caseInsensitive": true,
    "maxTags": 50,
    "syncTextToDataverseOnSave": true
  }
}
```

| Key | Required | Default | Notes |
|---|---|---|---|
| `tag.table` | yes | – | Logical name (lowercase). |
| `tag.nameColumn` | yes | – | Column used to search / create tags. Make it the primary name column and add an **alternate key** or duplicate-detection rule for safety. |
| `bridge` | **no** | – | If the whole section is omitted, the control runs in **text-only mode** (no Dataverse sync). |
| `bridge.table` | yes (if `bridge` present) | – | Logical name of the bridge table. |
| `bridge.targetLookup` | yes (if `bridge` present) | – | Logical name of the lookup column pointing to the host table. |
| `bridge.tagLookup` | yes (if `bridge` present) | – | Logical name of the lookup column pointing to the tag table. |
| `options.delimiter` | no | `;` | Single character or short string. Must not be a character used inside tags. |
| `options.caseInsensitive` | no | `true` | `Vip` and `vip` are the same tag locally. |
| `options.maxTags` | no | `50` | 1..500. |
| `options.syncTextToDataverseOnSave` | no | `true` | Bridge mode only. When the record loads, tags found in the text column but not in Dataverse are created. |

---

## Dataverse prerequisites (Bridge mode)

1. Create the **Tag** table (e.g. `gm_tag`) with a primary name column.
2. Create the **Bridge** table (e.g. `gm_accounttag`) with two **lookup** columns: one to the host table, one to the Tag table. Optionally add an alternate key on (`targetLookup`, `tagLookup`) to prevent duplicates server-side.
3. Add a **text column** on the host table for the delimited tags (e.g. `gm_tagstext`, 4000 chars recommended).
4. Security roles: users need **Read** on Tag and Bridge, **Create/Delete** on Bridge, **Create** on Tag (only if they may create new tags), **Append/Append To** on the involved tables.

Text-only mode needs only the text column (step 3).

---

## Build

```powershell
npm ci
npm run build          # output in out/controls
npm run lint
npm run start:watch    # UI harness; Dataverse integration must be tested in an environment
```

---

## Deploy to a Dataverse environment — step by step

### Prerequisites
- Node.js with npm supported by the PCF toolchain
- Visual Studio with **Developer PowerShell** and MSBuild
- .NET Framework 4.6.2 targeting support
- A Dataverse environment with solution-import permissions (System Customizer / System Administrator)

### Step A: Compile the PCF

Open **Developer PowerShell for Visual Studio** in the repository root:

```powershell
npm ci
npm run build
npm run lint   # optional
```

Continue only if you see `[build] Succeeded`.

### Step B: Get the solution package (managed ZIP)

Ready-made packages are in [`releases/`](releases) and on the [GitHub Releases](https://github.com/gmanunta81/GM-TagControl/releases) page: use `GMTagControl_<version>_managed.zip`. To build them yourself:

```powershell
msbuild Solution\Solution.cdsproj /restore /p:Configuration=Release /p:SolutionPackageType=Both
```

The ZIP files are placed in `Solution\bin\Release\`; use the one ending in `_managed.zip`. Do not zip `out/controls` manually.

### Step C: Import the solution

1. Open **https://make.powerapps.com** and select the target environment.
2. **Solutions** → **Import solution**.
3. Upload `GMTagControl_<version>_managed.zip` (from `releases/`).
4. Complete the wizard and wait for publishing (1–2 min).

The package contains the PCF control only: tables, columns and roles are created separately (Step D).

### Step D: Create the supporting tables and columns

**Table `gm_tag`** (unique tags)
- Display name `Tag`, plural `Tags`
- Primary name column `gm_name` (SingleLine.Text, max 100)

**Table `gm_accounttag`** (Account ↔ Tag links)
- Display name `Account Tag`, plural `Account Tags`
- Lookup `gm_accountid` → `account`
- Lookup `gm_tagid` → `gm_tag`
- Recommended: **Alternate key** on (`gm_accountid`, `gm_tagid`)

**Columns on `account`**
- `gm_tagstext` (SingleLine.Text, max 4000) — delimited tag list
- `gm_recordidtext` (SingleLine.Text, max 100) — optional, only if you want to pass `entityId` explicitly

Then **Publish all customizations**.

### Step E: Configure the control on the form

1. **Solutions** → open an unmanaged customization solution.
2. **Tables** → **Account** → **Forms** → open the main form.
3. Add the `gm_tagstext` field to the form.
4. Select the field → **Components** → **Get more components** → pick `TagControl` (namespace `GM`) → **Add**.
5. Set the properties:
   - `value` → bound to `gm_tagstext`
   - **Tag table** → `gm_tag`
   - **Tag name column** → `gm_name`
   - **Bridge table** → `gm_accounttag` (empty = text-only mode)
   - **Bridge lookup to record** → `gm_accountid`
   - **Bridge lookup to tag** → `gm_tagid`
   - Delimiter / Maximum tags / Case insensitive / Sync → optional
   - **Configuration JSON**, **Record id**, **Table name** → leave empty
6. **Save** and **Publish**.

### Populating `entityId` (Bridge mode)

Not needed on model-driven forms: when `entityId` / `entityName` are empty the control uses the host form context and refreshes automatically when a new record is saved. Bind them only for hosts without form context (e.g. custom pages), for example to a text column filled by this OnLoad script:

```javascript
function onLoad(executionContext) {
    const formContext = executionContext.getFormContext();
    const id = formContext.data.entity.getId();
    if (id) {
        formContext.getAttribute("gm_recordidtext").setValue(id.replace(/[{}]/g, ""));
    }
}
```

---

## Two test configurations

### Test A: Bridge mode (full Dataverse sync)

Set the five table/column properties as in Step E. Equivalent JSON (only if bound to a column):

```json
{
  "tag":    { "table": "gm_tag", "nameColumn": "gm_name" },
  "bridge": { "table": "gm_accounttag", "targetLookup": "gm_accountid", "tagLookup": "gm_tagid" },
  "options": { "delimiter": ";", "caseInsensitive": true, "maxTags": 50, "syncTextToDataverseOnSave": true }
}
```

Behaviour:
- Load → reads tags from `gm_accounttag` (source of truth) and rewrites `gm_tagstext`
- Add → creates the tag in `gm_tag` if missing, then the link in `gm_accounttag`
- Remove → deletes the link in `gm_accounttag` (the tag stays in `gm_tag`)

Test steps:
1. Open a saved Account.
2. Type `vip;` → chip appears; verify a row in `gm_tag` and one in `gm_accounttag`.
3. Remove the chip → the `gm_accounttag` row is deleted, `gm_tag` row remains.
4. Reload the form → chips match the Bridge table.

### Test B: Text-only mode (no Dataverse sync)

Set only **Tag table** and **Tag name column**; leave the three Bridge properties empty. Equivalent JSON (omit `bridge`):

```json
{
  "tag":    { "table": "gm_tag", "nameColumn": "gm_name" },
  "options": { "delimiter": ";", "caseInsensitive": true, "maxTags": 50 }
}
```

Behaviour:
- Add/remove → updates only `gm_tagstext`; no Web API calls
- Works on unsaved records and without `entityId`
- No privileges on Tag/Bridge tables are required

Test steps:
1. Apply this configuration to the same field (or another form).
2. Type `test1;test2;` → two chips appear; no rows are created in `gm_tag` / `gm_accounttag`.
3. Save and reload → chips are rebuilt from `gm_tagstext`.

---

## Releasing updates

For each update, increment the control version in `TagControl/ControlManifest.Input.xml` and the solution version in `Solution/src/Other/Solution.xml`, rebuild (Steps A–B), re-import (Step C). Keep the solution unique name and publisher unchanged. Do not mix managed and unmanaged installs of the same solution in one environment.

Do **not** commit build artifacts (`out/`, `bin/`, `obj/`). Only the published packages `releases/*.zip` are tracked; attach the same `_managed.zip` to a **GitHub Release** (tag `vX.Y.Z`).

Repository layout:

```
/
├─ TagControl/                 # PCF source
├─ Solution/                   # cdsproj + src/Other/Solution.xml (no bin/obj)
├─ docs/                       # screenshots
├─ releases/                   # managed + unmanaged solution zips
├─ README.md  LICENSE  CHANGELOG.md  CONTRIBUTING.md
└─ .github/workflows/build.yml # CI build on push/PR
```

---

## Requirements and licensing

- Power Apps model-driven app on Dataverse.
- The control calls only the Dataverse Web API of the current environment: it declares **no external service**, so it is **not a premium control**. Users need the standard Power Apps / Dynamics 365 license of the app.
- Dependencies: none beyond the platform (no runtime npm packages).
- Tested in model-driven apps (forms).

---

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| *Configuration JSON is missing or invalid …* | The message lists the exact key. Logical names must be lowercase and contain only `a-z0-9_`. |
| *Table "x" not found or not accessible* | Wrong logical name in config, or the table is not in the environment / user has no Read privilege. |
| *Invalid entityName* | `entityName` must be the logical name (`account`, not `Account`). |
| Tags appear only as text, message *Save the record to sync…* | Bridge mode on a new (unsaved) record, or a host without form context and no `entityId` input. |
| *Insufficient privileges to read tags from Dataverse* | Grant Read on Tag and Bridge tables. The control shows the text column as fallback. |
| Input box hidden | User lacks Create on Bridge or Read on Tag, or the field is read-only / FLS restricted. |
| Error `0x80040265` / plugin message on create | Alternate key or duplicate detection rule blocking; concurrent saves may race. |
| `@odata.bind` error / undeclared property | Verify entity-set names and the exact case-sensitive lookup navigation-property names in Dataverse metadata. |
| Control doesn't refresh after a plugin changes tags | Reload the form; the control reads Dataverse on configuration/`entityId`/`entityName` change only. |
| *The config_display property cannot be more than 100 characters* | Designer limit on static values (versions < 1.0.2). Upgrade to 1.0.2+ and use the individual properties. |
| Text-only mode: tags lost after reload | The record was not saved; text-only mode persists only through the bound `gm_tagstext` column. |
| Build warning *Browserslist data is old* | Warning only; run `npx update-browserslist-db@latest`. |

---

## Author

[Giovanni Manunta](https://github.com/gmanunta81)

## License

MIT – see [LICENSE](LICENSE).
