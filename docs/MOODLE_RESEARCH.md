# Moodle 4.x (Boost) DOM patterns for scraping KEATS

## Overview

This report documents stable DOM structures, selectors, and URL patterns for scraping course content and downloadable media from Moodle 4.x with the Boost-based UI, focusing on KEATS (King's College London) and common third-party media integrations (Kaltura, Echo360, Panopto, Mediasite). It is written for a Chrome extension that crawls course pages and resolves actual file/video URLs.

Unless stated otherwise, examples reflect Moodle 4.4/4.5+ core templates and typical plugin defaults.

---

## 1. Course page formats and section DOM

### 1.1 Core section wrapper (topics, weeks, most formats)

Moodle 4.4+ uses Mustache templates `core_courseformat/local/content/section` and `delegatedsection` as a generic wrapper around each section.

Canonical HTML (Boost):

```html
<ul class="topics">  <!-- or .weeks, or format-specific -->
  <li
      class="section course-section main clearfix current"
      data-sectionid="3"
      data-sectionreturnnum="0"
      data-for="section"
      data-id="35"
      data-number="3"
      data-sectionname="Week 3: Software design"
      role="region"
      aria-label="Week 3: Software design">
    <div class="section-item">
      <!-- section header + summary + activity list -->
    </div>
  </li>
</ul>
```

Key selectors:
- Section wrapper: `li.section.course-section.main[data-for="section"]`
- Section index: `li.section[data-number]` or `li#section-N`
- Section database id: `li.section[data-id]`
- Section display name: `li.section[data-sectionname]` (plain text) or from header

### 1.2 Section header / title element

Renders an `h3.sectionname`, often wrapping an `<a>` when the section is on a separate page.

```html
<li ...>
  <div class="section-item">
    <h3 id="sectionid-35-title" class="sectionname">
      <a href="https://moodle.example/course/view.php?id=5#section-3">
        Topic 3: Architectural styles
      </a>
    </h3>
    <div class="section-summary">...</div>
    <ul class="section img-text"><!-- activities --></ul>
  </div>
</li>
```

Selectors:
- Prefer: `li.section[data-sectionname]`
- Fallback: `li.section .sectionname` → `<a>` text or text node

### 1.3 `format_topics`

```html
<div class="course-content">
  <h2 class="accesshide">Topics</h2>
  <ul class="topics">
    <li>...</li>
    <li>...</li>
  </ul>
</div>
```

All sections: `.course-content ul.topics > li.section.course-section`

### 1.4 `format_weeks`

Same as topics but `<ul class="weeks">`. Current week often has `.current` class. `aria-label` is a date like "19 May".

### 1.5 `format_grid`

Hides normal section content and displays a grid of image tiles; clicking a tile opens content in lightbox or expands inline.

```html
<div class="gridicons">
  <ul>
    <li>
      <a href="#section-1" class="gridicon_link" aria-controls="section-1">
        <span class="image_holder">
          <img src=".../pluginfile.php/.../gridicon.jpg" alt="Week 1" />
        </span>
        <span class="gridicon_title">Week 1</span>
      </a>
    </li>
  </ul>
</div>
```

Selectors:
- Section wrapper (same page): `li.section.course-section` (may be hidden)
- Grid tile: `.gridicons li.gridicon[data-section]`
- Tile title: `.gridicons li.gridicon .gridicon_title`
- Mapping: `data-section` or `href="#section-N"`

Content location: usually same-page hidden `li.section`. Some configs navigate to `/course/view.php?id=...&section=N`.

### 1.6 `format_topcoll` (Collapsed Topics)

```html
<ul class="ctopics">
  <li>
    <div class="content">
      <div class="toggle">
        <div class="toggle-arrow">
          <a class="toggle_open" href="#section-1" aria-expanded="true"></a>
        </div>
        <h3 class="sectionname">Week 1</h3>
      </div>
      <div class="sectionbody" aria-hidden="false">
        <ul class="section img-text">...</ul>
      </div>
    </div>
  </li>
</ul>
```

Selectors:
- Section wrapper: `.course-content ul.ctopics > li.section`
- Title: `.course-content ul.ctopics li.section .sectionname`
- Toggle: `.toggle-arrow a.toggle_open` (expanded) / `a.toggle_closed` (collapsed)
- State: `aria-expanded="true|false"` on toggle (newer ES6 refactor)
- Content: inside `.sectionbody`

### 1.7 `format_onetopic` (tabbed)

```html
<div class="onetopic">
  <ul class="nav nav-tabs">
    <li class="nav-item"><a href=".../course/view.php?id=5&section=1">Week 1</a></li>
    <li class="nav-item"><a href=".../course/view.php?id=5&section=2">Week 2</a></li>
  </ul>
  <div class="tab-content">
    <div class="tab-pane active" id="onetopic-section-1">
      <ul class="section img-text"><!-- li.activity --></ul>
    </div>
  </div>
</div>
```

Selectors:
- Visible section: `.onetopic .tab-pane.active`
- Activities: `.onetopic .tab-pane.active ul.section > li.activity`
- Tabs: `.onetopic ul.nav-tabs li.nav-item > a`

Iterate `section=N` URLs to capture all sections.

### 1.8 `format_tiles`

```html
<div class="format-tiles">
  <div class="tiles">
    <div class="tile" data-section="1" data-sectionid="1" aria-expanded="false">
      <a href="#section-1" class="tile-link">
        <span class="tile-icon"><i class="fa fa-book"></i></span>
        <span class="tile-title">Week 1</span>
      </a>
    </div>
  </div>
  <div id="section-1" class="section course-section tile-section" data-sectionid="1" hidden>
    <ul class="section img-text"><!-- li.activity --></ul>
  </div>
</div>
```

Selectors:
- Tile: `.format-tiles .tile[data-section]` or `.tile[data-sectionid]`
- Title: `.format-tiles .tile .tile-title`
- Expanded: `.tile[aria-expanded="true"]`
- Section content: `div.section.tile-section[data-sectionid="N"]` or `#section-N`

Default: same-page hidden content. Optional one-section-per-page mode.

### 1.9 `format_flexsections`

Nested sections (subsections) with optional per-section pages. Each section is still `li.section` using core templates but can be nested. Sections may be inline OR on a separate page where `h3.sectionname a[href*="section="]` navigates there.

---

## 2. Activity / module types with downloadable content

### 2.1 General activity list structure

```html
<ul class="section img-text">
  <li class="activity resource modtype_resource" data-for="cm" data-id="23" data-cmid="23">
    <div class="activity-item">
      <div class="activity-icon">...</div>
      <div class="activityinstance">
        <a class="aalink" href="/mod/resource/view.php?id=23">
          <span class="instancename">Lecture slides<span class="accesshide"> File</span></span>
        </a>
      </div>
      <div class="contentafterlink">Optional description...</div>
    </div>
  </li>
</ul>
```

Selectors:
- Activity wrapper: `li.activity[data-for="cm"]`
- Module type class: `li.activity.modtype_[modname]`
- Main link: `.activityinstance > a.aalink`
- Display name: `.activityinstance .instancename` (strip `.accesshide`)
- Description: `.contentafterlink`

### 2.2 `modtype_page`

Page is HTML stored in DB; embedded files use `pluginfile.php`.

View page (`/mod/page/view.php?id=45`):
```html
<div class="box py-3 generalbox pagecontent">
  <div class="no-overflow">
    <p><a href="/pluginfile.php/12345/mod_page/content/1/file.pdf">Download PDF</a></p>
    <video controls>
      <source src="/pluginfile.php/12345/mod_page/content/1/clip.mp4" type="video/mp4">
    </video>
  </div>
</div>
```

Scrape: any `<a href*="/pluginfile.php/"]` or `<source src*="/pluginfile.php/"]` within `.pagecontent` / `.generalbox`.

### 2.3 `modtype_book`

Multiple HTML chapters at `/mod/book/view.php?id=52&chapterid=N`.

```html
<div class="book_content">
  <p><a href="/pluginfile.php/67890/mod_book/chapter/493/notes.pdf">PDF</a></p>
</div>
```

Scrape: `.book_content a[href*="/pluginfile.php/"]` and media tags. Need to iterate all chapters.

### 2.4 `modtype_url`

Can link directly out or redirect through `view.php` first.

View page:
```html
<div class="urlworkaround">
  <a class="btn btn-primary" href="https://mediaspace.example.edu/media/1234">Open in new window</a>
</div>
<!-- or iframe -->
<div class="urlworkaround">
  <iframe src="https://mediaspace.example.edu/embed/1234" ...></iframe>
</div>
```

Scrape: `.urlworkaround a[href]` or `.urlworkaround iframe[src]`. **External systems may need their own auth** (Kaltura MediaSpace, Panopto).

### 2.5 `modtype_assign` (attachments)

Assignment intro:
```html
<div class="box py-3 generalbox boxaligncenter" id="intro">
  <div class="no-overflow">
    <p><a href="/pluginfile.php/34567/mod_assign/intro/0/brief.pdf">Brief</a></p>
  </div>
</div>
```

Scrape: `#intro a[href*="/pluginfile.php/"]`. Student submissions handled by `assignsubmission_file_pluginfile`.

### 2.6 `modtype_quiz`

Files may exist in:
- Quiz intro: `.quizinfo a[href*="/pluginfile.php/"]` or `#intro a[href*="/pluginfile.php/"]`
- Question text: `.que .qtext a[href*="/pluginfile.php/"]`

### 2.7 `modtype_glossary`

Entry: `.glossarypost .entry` → scan for pluginfile links and media tags.

### 2.8 `modtype_hvp` (H5P)

Loads content JSON and assets via `pluginfile.php/.../mod_hvp/...`. Direct extraction non-trivial. Look for `.h5p-actions` Download button if export allowed.

### 2.9 `modtype_scorm`

Launch via `iframe[src*="/mod/scorm/player.php"]`. Package zip at `pluginfile.php/.../mod_scorm/package/...zip` if download enabled.

### 2.10 `modtype_label` (Text and media area)

Inline HTML blocks in a section. Can embed files.

```html
<li class="activity modtype_label">
  <div class="activity-item">
    <div class="activityinstance">
      <div class="contentwithoutlink">
        <div class="no-overflow">
          <h3>Lectures</h3>
          <p>Watch the videos below.</p>
          <p><a href="/pluginfile.php/12345/mod_label/intro/0/banner.png">Image</a></p>
        </div>
      </div>
    </div>
  </div>
</li>
```

Selectors:
- Wrapper: `li.activity.modtype_label`
- Content root: `.activityinstance .contentwithoutlink .no-overflow`
- Files: `a[href*="/pluginfile.php/"]`, `img[src*="/pluginfile.php/"]` within

### 2.11 Media LTIs and additional video activity types

- `modtype_lti` — Echo360, Panopto, Mediasite, Zoom
- `modtype_zoom` — Zoom plugin (institution-specific)
- `modtype_kalmediares` / `modtype_kalmediaassign` — Kaltura plugins
- `modtype_forum`, `modtype_workshop` — can embed media in posts (less reliable)

LTI activity:
```html
<li class="activity modtype_lti">
  <div class="activityinstance">
    <a class="aalink" href="/mod/lti/view.php?id=120">
      <span class="instancename">Echo360: Week 1 Lecture</span>
    </a>
  </div>
</li>
```

LTI view page:
```html
<div class="LaunchContainer">
  <iframe src="https://echo360.example.edu/lti/launch?context_id=..." ...></iframe>
</div>
```

Detect provider via iframe src host: `echo360`, `panopto`, `mediasite`.

---

## 3. Labels, headings, and sub-section grouping

### 3.1 Label heading patterns

No semantic flag distinguishes "subsection heading" from descriptive label. Common author conventions on KEATS:

```html
<!-- H3/H4 heading -->
<li class="activity modtype_label">
  <div class="contentwithoutlink"><div class="no-overflow">
    <h3>Lectures</h3>
  </div></div>
</li>

<!-- Bold pseudo-heading -->
<li class="activity modtype_label">
  <div class="contentwithoutlink"><div class="no-overflow">
    <p><strong>Tutorials</strong></p>
  </div></div>
</li>
```

### 3.2 Heuristics for identifying header labels

Practical classifier:

1. Select candidates: `sectionEl.querySelectorAll('li.activity.modtype_label .contentwithoutlink .no-overflow')`
2. For each `labelRoot`:
   - Contains `h2, h3, h4` element with no/minimal siblings → header
   - First `<p>` whose only child is `<strong>` or `<b>`, short text → header
   - Text matches known patterns: "Lectures", "Tutorials", "Reading", "Assessment", "Labs", "Resources [Mandatory]", "Resources [Optional]"
3. Else treat as description.

Boost forbids H1/H2 in Atto editor (reserved for course/block titles), so H3-H5 are convention for subtopics.

### 3.3 Native subsections vs label-based grouping

Moodle 4.3+ has core subsections rendered as nested `li.section` with additional `data-*` attributes.

**Prefer native subsections when present.** Use label-derived grouping as fallback.

---

## 4. Kaltura video embeds and resolution

### 4.1 Iframe chain

Activity:
```html
<li class="activity modtype_kalvidres">
  <a class="aalink" href="/mod/kalvidres/view.php?id=140">
    <span class="instancename">Week 1 lecture</span>
  </a>
</li>
```

View page:
```html
<iframe id="kaltura_player_ifp" class="kaltura-player-iframe"
        src="https://12345.kaf.kaltura.com/kwidget/wid/_12345/uiconf_id/67890/entry_id/1_abcdxyz?..."
        allowfullscreen></iframe>
```

Selectors:
- Outer (Moodle page): `iframe[src*=".kaf.kaltura.com"]`
- Inner: `iframe[src*="/p/"][src*="/sp/"][src*="playManifest"]` or `div[id^="kaltura_player"]`

### 4.2 Detecting V2 vs V7 player

V7 (preferred):
```js
window.kalturaIframePackageData = {
  playerConfig: {
    targetId: 'kaltura_player',
    provider: { partnerId: 12345, uiConfId: 67890 },
    entryId: '1_abcdxyz',
    session: { ks: '...' }
  }
};
```

V2 (legacy):
```js
kWidget.embed({
  targetId: 'kaltura_player',
  wid: '_12345',  // partner ID with underscore
  uiconf_id: 67890,
  entry_id: '1_abcdxyz',
  flashvars: { ks: '...' }
});
```

Detection:
```js
let flavor = null;
if (window.kalturaIframePackageData?.playerConfig) flavor = 'v7';
else if (typeof window.kWidget?.embed === 'function') flavor = 'v2';
```

### 4.3 Locating entryId, partnerId, ks

V7:
```js
const pkg = window.kalturaIframePackageData;
const entryId = pkg.playerConfig.entryId;
const partnerId = pkg.playerConfig.provider.partnerId;
const ks = pkg.playerConfig.session?.ks;
```

V2: parse `kWidget.embed` args. `wid` without underscore = partnerId.

Also observe network requests to `https://cdnapisec.kaltura.com/p/{partnerId}/sp/{partnerId}00/playManifest/...` which include `ks`.

### 4.4 Resolving direct download URL

Try in order:

1. **Public playManifest** (no ks needed if public):
   ```
   https://cdnapisec.kaltura.com/p/{partnerId}/sp/{partnerId}00/playManifest/entryId/{entryId}/format/download/protocol/https/flavorParamIds/0
   ```

2. **playManifest with KS**:
   ```
   https://cdnapisec.kaltura.com/p/{partnerId}/sp/{partnerId}00/playManifest/entryId/{entryId}/ks/{ks}/format/url/flavorParamId/{flavorId}/video.mp4
   ```

3. **Server-side API** (`baseEntry.get`, `flavorAsset.getUrl`) — not feasible client-side.

For browser extension, options 1-2 only.

### 4.5 Disabled downloads / fallbacks

When `format/download` disabled in KAF:
- 403/404 or manifest with no downloadable flavor
- Try `format/url/flavorParamId/{id}` as fallback
- HLS (`format/applehttp`) circumvents protections — not appropriate

Detect quickly:
- HEAD or GET with 5-10s timeout
- 403/404/410 or empty manifest = "stream-only"
- Don't retry

### 4.6 Avoiding hangs

Try in order, each with 5-10s timeout:
1. `format/download` no KS
2. `format/download` with KS
3. `format/url` with KS

After 2 consecutive failures, mark non-downloadable.

---

## 5. Echo360, Panopto, Mediasite LTI embeds

### 5.1 Detecting LTI launch URLs

All share `mod_lti`. View page:
```html
<div class="launchcontainer">
  <iframe src="https://echo360.org.uk/lti/launch?context_id=..." ...></iframe>
</div>
```

Detect provider by iframe src host.

### 5.2 Direct MP4 without LTI handshake?

Generally **no**. Provider uses OAuth/LTI to issue session linked to LMS identity. Media URLs generated by provider after launch.

Browser extension running in user's authenticated session can piggyback by inspecting embedded page, but cannot bypass server-side.

### 5.3 Echo360

- **No simple unauthenticated MP4 endpoint** for `lessonId`/`mediaId`
- Downloads via Echo360 UI with authenticated API + cookies + possibly CSRF
- From within Echo360 iframe context, observe XHR to `/api/media/{id}/...` returning streaming URLs

No portable recipe like Kaltura's playManifest.

### 5.4 Panopto / Mediasite

- Panopto: `/Panopto/Pages/Embed.aspx?id={GUID}`. Direct MP4 gated.
- Mediasite: own player, own APIs, LTI launches into its domain.

Generic approach:
- Detect provider via iframe host
- Hand off to provider-specific logic in iframe context using authenticated session
- Expect downloads disabled in many institutional configs

---

## 6. Moodle `pluginfile.php` URL mechanics

### 6.1 URL structure

```text
/pluginfile.php/{contextid}/{component}/{filearea}/{itemid}{filepath}/{filename}
```

Example:
```text
/pluginfile.php/288409/mod_resource/content/0/movie%205773/150151.5773.week1.wmv?forcedownload=1
```

### 6.2 `webservice/pluginfile.php`

Same structure but **requires** `?token={wstoken}`. Used by mobile/external. For browser extension with cookies, use plain `pluginfile.php`.

### 6.3 forcedownload and Content-Disposition

`forcedownload=1` → `Content-Disposition: attachment; filename="..."`. Otherwise inline. Doesn't change file path/auth.

### 6.4 Resolving view.php → pluginfile.php WITHOUT opening tab

Use fetch with `redirect: 'manual'`:

```js
const res = await fetch('/mod/resource/view.php?id=123', {
  redirect: 'manual',
  credentials: 'include',
});
const location = res.headers.get('Location');
// If location starts with /pluginfile.php/, use that as final URL.
```

This avoids spinning up a hidden tab — server-side 303/302 redirect includes fully resolved URL.

**KEY OPTIMIZATION** for current scraper: replace tab navigation with this fetch pattern.

---

## 7. Folder (`mod_folder`) view page structure

### 7.1 Folder view HTML

```html
<div class="generalbox foldertree">
  <ul class="tree root_folder">
    <li class="folder">
      <span class="fp-folder">Week 1</span>
      <ul>
        <li class="file">
          <a href="/pluginfile.php/.../mod_folder/content/0/Week1/slides.pdf" class="fp-filename-icon">
            <span class="fp-icon"><img src=".../pdf-24.png" alt="" /></span>
            <span class="fp-filename">slides.pdf</span>
          </a>
        </li>
        <li class="folder">
          <span class="fp-folder">Tutorials</span>
          <ul>
            <li class="file">...</li>
          </ul>
        </li>
      </ul>
    </li>
  </ul>
</div>
```

Selectors:
- Container: `.generalbox.foldertree`
- File entries: `.foldertree a.fp-filename-icon[href*="/pluginfile.php/"]`
- File name: `.fp-filename`
- Folder names: `.foldertree .folder > .fp-folder`

### 7.2 Nested folder reconstruction

Traverse from `.foldertree ul.tree`. Maintain path stack of folder names. For each `a.fp-filename-icon`, output `{folderPath, filename, url}`.
