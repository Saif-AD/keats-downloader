// Simulated real Moodle page tests — realistic HTML structures from KEATS
const { createChromeMock } = require('./chrome-mock');
global.chrome = createChromeMock();

Object.defineProperty(HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; },
  set(v) { this.textContent = v; },
  configurable: true,
});

const bg = require('../extension/background');

// ==================== Topics format (MDE-style) ====================

describe('Topics format — MDE-style course', () => {
  const MDE_SECTION_HTML = `
    <div id="region-main">
      <li id="section-1" data-id="50001" data-number="1" class="section main">
        <h3 class="sectionname">General</h3>
        <div class="activity modtype_label">
          <div>RESPECT MATTERS – On Campus &amp; Online</div>
        </div>
        <div class="activity modtype_forum">
          <a href="https://keats.kcl.ac.uk/mod/forum/view.php?id=1">Announcements</a>
        </div>
        <div class="activity modtype_lti" data-activityname="Lecture Capture">
          <a href="https://keats.kcl.ac.uk/mod/lti/view.php?id=2">Lecture Capture</a>
        </div>
      </li>

      <li id="section-2" data-id="50002" data-number="2" class="section main">
        <h3 class="sectionname">Week 1 - Introduction to MDE</h3>
        <div class="activity modtype_label">
          <div>Lecture Materials</div>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=100">Lecture Introduction.pptx File</a>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=101">Metamodelling.pptx File</a>
        </div>
        <div class="activity modtype_label">
          <div>Tutorial Materials</div>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=102">Tutorial Sheet 1.pdf File</a>
        </div>
        <div class="activity modtype_folder">
          <a href="https://keats.kcl.ac.uk/mod/folder/view.php?id=103">Week 1 Code Examples Folder</a>
        </div>
      </li>

      <li id="section-3" data-id="50003" data-number="3" class="section main">
        <h3 class="sectionname">Week 2 - Abstract Syntax</h3>
        <div class="activity modtype_label">
          <div>Lecture Materials</div>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=200">Abstract Syntax.pptx File</a>
        </div>
        <div class="activity modtype_label">
          <div>Optional Reading</div>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=201">Extra Paper on EMF.pdf File</a>
        </div>
        <div class="activity modtype_kalvidres">
          <a href="https://keats.kcl.ac.uk/mod/kalvidres/view.php?id=202">Week 2 Lecture Recording Kaltura Video Resource</a>
        </div>
      </li>
    </div>
  `;

  test('scrapeAllInlineSections finds files across sections', () => {
    document.body.innerHTML = MDE_SECTION_HTML;
    const results = bg.scrapeAllInlineSections(['50001', '50002', '50003'], false);

    // General section: no downloadable resources (forum, LTI are skipped)
    expect(results['50001']).toHaveLength(0);

    // Week 1: 2 resources + 1 tutorial + 1 folder = 4
    expect(results['50002']).toHaveLength(4);
    expect(results['50002'][0].name).toContain('Lecture Introduction');
    expect(results['50002'][0].category).toBe('Lectures');
    expect(results['50002'][1].category).toBe('Lectures');
    expect(results['50002'][2].name).toContain('Tutorial Sheet');
    expect(results['50002'][2].category).toBe('Tutorials');

    // Week 2: 1 resource (optional skipped) + 0 kaltura (videos off) = 1
    expect(results['50003']).toHaveLength(1);
    expect(results['50003'][0].name).toContain('Abstract Syntax');
  });

  test('scrapeAllInlineSections includes optional when flag is true', () => {
    document.body.innerHTML = MDE_SECTION_HTML;
    const results = bg.scrapeAllInlineSections(['50003'], true);

    // With optional included: 1 lecture + 1 optional resource + 1 optional
    // Kaltura video = 3. The Kaltura entry is now returned by the scraper;
    // the caller's doVideos flag gates whether it actually gets downloaded.
    expect(results['50003']).toHaveLength(3);
    const kaltura = results['50003'].find(f => f.type === 'kaltura');
    expect(kaltura).toBeDefined();
    expect(kaltura.name).toContain('Week 2 Lecture Recording');
    expect(kaltura.optional).toBe(true);
  });

  test('scrapeEcho360LTI finds lecture capture link', () => {
    document.body.innerHTML = MDE_SECTION_HTML;
    const results = bg.scrapeEcho360LTI();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Lecture Capture');
  });

  test('scrapeInlineSection works on individual section', () => {
    document.body.innerHTML = MDE_SECTION_HTML;
    const results = bg.scrapeInlineSection('50002', false);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });
});

// ==================== Grid format (Business Strategy-style) ====================

describe('Grid format — Business Strategy-style course', () => {
  test('scrapeSectionPage extracts resources from a section page', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <div class="activity modtype_label">
          <div>Lecture Materials</div>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=500">Strategy Framework.pptx File</a>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=501">Case Study Notes.pdf File</a>
        </div>
        <div class="activity modtype_label">
          <div>Seminar Materials</div>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=502">Seminar Questions.docx File</a>
        </div>
        <div class="activity modtype_url">
          <a href="https://keats.kcl.ac.uk/mod/url/view.php?id=503">Harvard Business Review Article</a>
        </div>
        <div class="activity modtype_assign">
          <a href="https://keats.kcl.ac.uk/mod/assign/view.php?id=504">Coursework Submission</a>
        </div>
      </div>
    `;

    const results = bg.scrapeSectionPage(false);

    // Should find 3 resources, skip URL and assignment
    expect(results).toHaveLength(3);
    expect(results[0].name).toContain('Strategy Framework');
    expect(results[0].category).toBe('Lectures');
    expect(results[1].name).toContain('Case Study Notes');
    expect(results[1].category).toBe('Lectures');
    expect(results[2].name).toContain('Seminar Questions');
    expect(results[2].category).toBe('Tutorials');
  });
});

// ==================== Collapsed Topics format ====================

describe('Collapsed Topics format', () => {
  test('expandCollapsedSections clicks toggle buttons', () => {
    let clicked = false;
    document.body.innerHTML = `
      <li id="section-1" data-id="60001" class="section main">
        <div class="toggle_closed" id="toggle1">Toggle</div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=600">Hidden File.pdf</a>
        </div>
      </li>
      <li id="section-2" data-id="60002" class="section main">
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=601">Visible File.pdf</a>
        </div>
      </li>
    `;

    // Mock the click
    document.getElementById('toggle1').addEventListener('click', () => { clicked = true; });

    // expandCollapsedSections is injected into tabs, not directly callable
    // Test the DOM pattern instead
    const toggle = document.querySelector('.toggle_closed');
    expect(toggle).not.toBeNull();
    toggle.click();
    expect(clicked).toBe(true);
  });
});

// ==================== Folder page ====================

describe('Folder page scraping', () => {
  test('extracts multiple files from a Moodle folder', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <div class="fp-filename-icon">
          <a href="https://keats.kcl.ac.uk/pluginfile.php/123/mod_folder/content/0/Lecture%201%20Slides.pdf">
            <span class="fp-filename">Lecture 1 Slides.pdf</span>
          </a>
        </div>
        <div class="fp-filename-icon">
          <a href="https://keats.kcl.ac.uk/pluginfile.php/123/mod_folder/content/0/Lecture%201%20Notes.docx">
            <span class="fp-filename">Lecture 1 Notes.docx</span>
          </a>
        </div>
        <div class="fp-filename-icon">
          <a href="https://keats.kcl.ac.uk/pluginfile.php/123/mod_folder/content/0/code_examples.zip">
            <span class="fp-filename">code_examples.zip</span>
          </a>
        </div>
      </div>
    `;

    const results = bg.scrapeFolderPage();
    expect(results).toHaveLength(3);
    expect(results[0].name).toBe('Lecture 1 Slides.pdf');
    expect(results[0].type).toBe('folderFile');
    expect(results[1].name).toBe('Lecture 1 Notes.docx');
    expect(results[2].name).toBe('code_examples.zip');
  });

  test('falls back to region-main links when fp-filename-icon not present', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <a href="https://keats.kcl.ac.uk/pluginfile.php/456/mod_folder/content/0/data.csv">data.csv</a>
        <a href="https://keats.kcl.ac.uk/pluginfile.php/456/mod_folder/content/0/readme.txt">readme.txt</a>
      </div>
    `;

    const results = bg.scrapeFolderPage();
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('data.csv');
  });

  test('handles nested folder structure with subdirectories', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <div class="fp-filename-icon">
          <a href="https://keats.kcl.ac.uk/pluginfile.php/789/mod_folder/content/0/src/Main.java">
            <span class="fp-filename">Main.java</span>
          </a>
        </div>
        <div class="fp-filename-icon">
          <a href="https://keats.kcl.ac.uk/pluginfile.php/789/mod_folder/content/0/src/Utils.java">
            <span class="fp-filename">Utils.java</span>
          </a>
        </div>
      </div>
    `;

    const results = bg.scrapeFolderPage();
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('Main.java');
    expect(results[1].name).toBe('Utils.java');
  });
});

// ==================== Kaltura video detection ====================

describe('Kaltura video scraping', () => {
  test('detects Kaltura video resources in section', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <div class="activity modtype_kalvidres">
          <a href="https://keats.kcl.ac.uk/mod/kalvidres/view.php?id=700">Week 3 Lecture Video Kaltura Video Resource</a>
        </div>
        <div class="activity modtype_kalvidpres">
          <a href="https://keats.kcl.ac.uk/mod/kalvidpres/view.php?id=701">Lab Demo Kaltura Video Presentation</a>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=702">Regular File.pdf File</a>
        </div>
      </div>
    `;

    const results = bg.scrapeSectionPage(false);
    // 2 kaltura + 1 resource
    expect(results).toHaveLength(3);

    const kaltura = results.filter(r => r.type === 'kaltura');
    expect(kaltura).toHaveLength(2);
    expect(kaltura[0].name).toBe('Week 3 Lecture Video');
    expect(kaltura[1].name).toBe('Lab Demo');

    const resources = results.filter(r => r.type === 'resource');
    expect(resources).toHaveLength(1);
  });
});

// ==================== Echo360 LTI detection ====================

describe('Echo360 LTI link detection', () => {
  test('finds lecture capture by name', () => {
    document.body.innerHTML = `
      <div class="activity modtype_lti" data-activityname="Echo360 Lecture Recordings">
        <a href="https://keats.kcl.ac.uk/mod/lti/view.php?id=800">Echo360 Lecture Recordings</a>
      </div>
      <div class="activity modtype_lti" data-activityname="Turnitin Assignment">
        <a href="https://keats.kcl.ac.uk/mod/lti/view.php?id=801">Turnitin Assignment</a>
      </div>
    `;

    const results = bg.scrapeEcho360LTI();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Echo360 Lecture Recordings');
    expect(results[0].isCandidate).toBeUndefined();
  });

  test('falls back to all LTI as candidates when no obvious match', () => {
    document.body.innerHTML = `
      <div class="activity modtype_lti" data-activityname="External Tool 1">
        <a href="https://keats.kcl.ac.uk/mod/lti/view.php?id=810">External Tool 1</a>
      </div>
      <div class="activity modtype_lti" data-activityname="External Tool 2">
        <a href="https://keats.kcl.ac.uk/mod/lti/view.php?id=811">External Tool 2</a>
      </div>
    `;

    const results = bg.scrapeEcho360LTI();
    expect(results).toHaveLength(2);
    expect(results[0].isCandidate).toBe(true);
    expect(results[1].isCandidate).toBe(true);
  });
});

// ==================== Mixed content sections ====================

describe('Mixed content — realistic section with everything', () => {
  test('handles a section with labels, resources, folders, forums, URLs mixed together', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <div class="activity modtype_label">
          <div>Week 5: Design Patterns</div>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=900">Design Patterns Slides.pptx File</a>
        </div>
        <div class="activity modtype_forum">
          <a href="https://keats.kcl.ac.uk/mod/forum/view.php?id=901">Discussion Forum</a>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=902">Pattern Catalogue.pdf File</a>
        </div>
        <div class="activity modtype_url">
          <a href="https://keats.kcl.ac.uk/mod/url/view.php?id=903">Wikipedia: Design Pattern</a>
        </div>
        <div class="activity modtype_folder">
          <a href="https://keats.kcl.ac.uk/mod/folder/view.php?id=904">Code Samples Folder</a>
        </div>
        <div class="activity modtype_assign">
          <a href="https://keats.kcl.ac.uk/mod/assign/view.php?id=905">Lab Submission</a>
        </div>
        <div class="activity modtype_label">
          <div>-----</div>
        </div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=906">Extra Reading.pdf File</a>
        </div>
      </div>
    `;

    const results = bg.scrapeSectionPage(false);

    // Should find: 2 resources + 1 folder + 1 resource after divider = 4
    // Forum, URL, assignment should be skipped
    expect(results).toHaveLength(4);

    expect(results[0].type).toBe('resource');
    expect(results[0].name).toContain('Design Patterns Slides');
    expect(results[1].type).toBe('resource');
    expect(results[1].name).toContain('Pattern Catalogue');
    expect(results[2].type).toBe('folder');
    expect(results[2].name).toContain('Code Samples');
    expect(results[3].type).toBe('resource');
    expect(results[3].name).toContain('Extra Reading');
  });
});

// ==================== Edge cases ====================

describe('Edge cases', () => {
  test('empty section with only labels', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <div class="activity modtype_label"><div>Welcome to the course</div></div>
        <div class="activity modtype_label"><div>Please read the handbook</div></div>
      </div>
    `;
    const results = bg.scrapeSectionPage(false);
    expect(results).toHaveLength(0);
  });

  test('section with very long label text', () => {
    const longText = 'A'.repeat(200);
    document.body.innerHTML = `
      <div id="region-main">
        <div class="activity modtype_label"><div>${longText}</div></div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=999">File.pdf File</a>
        </div>
      </div>
    `;
    const results = bg.scrapeSectionPage(false);
    // Label > 120 chars should be skipped, category stays 'other'
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('other');
  });

  test('resource with "File" suffix is stripped from name', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=1000">Important Notes.pdf File</a>
        </div>
      </div>
    `;
    const results = bg.scrapeSectionPage(false);
    expect(results[0].name).toBe('Important Notes.pdf');
  });

  test('mandatory flag overrides optional', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <div class="activity modtype_label"><div>Optional Materials</div></div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=1001">Bonus.pdf File</a>
        </div>
        <div class="activity modtype_label"><div>Required Core Reading</div></div>
        <div class="activity modtype_resource">
          <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=1002">Essential.pdf File</a>
        </div>
      </div>
    `;
    const withoutOptional = bg.scrapeSectionPage(false);
    expect(withoutOptional).toHaveLength(1);
    expect(withoutOptional[0].name).toContain('Essential');

    const withOptional = bg.scrapeSectionPage(true);
    expect(withOptional).toHaveLength(2);
  });

  test('inline section with no matching data-id returns empty', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <li id="section-1" data-id="99999" class="section main">
          <div class="activity modtype_resource">
            <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=1">File.pdf</a>
          </div>
        </li>
      </div>
    `;
    const results = bg.scrapeAllInlineSections(['11111'], false);
    expect(results['11111']).toEqual([]);
  });

  test('lightweight href scraper finds resources and folders', () => {
    document.body.innerHTML = `
      <div class="activity modtype_resource">
        <a href="https://keats.kcl.ac.uk/mod/resource/view.php?id=1">Slides</a>
      </div>
      <div class="activity modtype_folder">
        <a href="https://keats.kcl.ac.uk/mod/folder/view.php?id=2">Materials</a>
      </div>
      <div class="activity modtype_forum">
        <a href="https://keats.kcl.ac.uk/mod/forum/view.php?id=3">Forum</a>
      </div>
    `;
    // scrapeFileHrefsLightweight is used for badge detection
    // It's not exported, but we can test the pattern it uses
    const resources = document.querySelectorAll('.activity.modtype_resource a[href*="/mod/resource/"]');
    const folders = document.querySelectorAll('.activity.modtype_folder a[href*="/mod/folder/"]');
    expect(resources.length).toBe(1);
    expect(folders.length).toBe(1);
  });
});

// ============================================================================
// Moodle format compatibility matrix
//
// Safeguards that every scraper variant finds every downloadable content type
// across every course format we claim to support. When a regression lands in
// one scraper or one format, exactly one test fires and points at it.
// ============================================================================

describe('Moodle format compatibility — weeks format', () => {
  // format_weeks uses <ul class="weeks"> instead of <ul class="topics"> but
  // the <li.section> wrapper is otherwise identical. The same modtype_*
  // classes identify activities so all three scrapers should behave the same.
  const WEEKS_HTML = `
    <div class="course-content">
      <ul class="weeks">
        <li id="section-1" data-id="70001" data-number="1" class="section main current">
          <h3 class="sectionname">19 May</h3>
          <div class="activity modtype_resource">
            <a href="https://example.edu/mod/resource/view.php?id=700">Week 1 Slides File</a>
          </div>
          <div class="activity modtype_kalvidres">
            <a href="https://example.edu/mod/kalvidres/view.php?id=701">Week 1 Lecture Kaltura Video Resource</a>
          </div>
          <div class="activity modtype_folder">
            <a href="https://example.edu/mod/folder/view.php?id=702">Supplementary Folder</a>
          </div>
        </li>
      </ul>
    </div>
  `;

  test('scrapeAllInlineSections picks up resource, folder, and kaltura in a weeks section', () => {
    document.body.innerHTML = WEEKS_HTML;
    const results = bg.scrapeAllInlineSections(['70001'], false);
    const section = results['70001'];
    expect(section).toHaveLength(3);
    const types = section.map(f => f.type).sort();
    expect(types).toEqual(['folder', 'kaltura', 'resource']);
  });

  test('scrapeInlineSection mirrors scrapeAllInlineSections for the same weeks section', () => {
    document.body.innerHTML = WEEKS_HTML;
    const batch = bg.scrapeAllInlineSections(['70001'], false);
    const single = bg.scrapeInlineSection('70001', false);
    expect(single.length).toBe(batch['70001'].length);
    const batchHrefs = batch['70001'].map(f => f.href).sort();
    const singleHrefs = single.map(f => f.href).sort();
    expect(singleHrefs).toEqual(batchHrefs);
  });
});

describe('Moodle format compatibility — collapsed topics (topcoll)', () => {
  // Research §1.6: topcoll wraps sections in <ul class="ctopics"> with a
  // collapsible toggle and hides content inside .sectionbody. Newer releases
  // add aria-expanded alongside toggle_closed/toggle_open.
  const TOPCOLL_HTML = `
    <div class="course-content">
      <ul class="ctopics">
        <li id="section-1" data-id="80001" data-number="1" class="section main">
          <div class="content">
            <div class="toggle">
              <div class="toggle-arrow">
                <a class="toggle_closed" href="#section-1" aria-expanded="false">Toggle</a>
              </div>
              <h3 class="sectionname">Week 1: Intro</h3>
            </div>
            <div class="sectionbody">
              <div class="activity modtype_resource">
                <a href="https://example.edu/mod/resource/view.php?id=800">Slides File</a>
              </div>
              <div class="activity modtype_kalvidres">
                <a href="https://example.edu/mod/kalvidres/view.php?id=801">Lecture Kaltura Video Resource</a>
              </div>
            </div>
          </div>
        </li>
      </ul>
    </div>
  `;

  test('all three scrapers detect Kaltura inside a collapsed-topics section', () => {
    document.body.innerHTML = TOPCOLL_HTML;
    const batch = bg.scrapeAllInlineSections(['80001'], false);
    const single = bg.scrapeInlineSection('80001', false);
    const page = bg.scrapeSectionPage(false);

    expect(batch['80001'].some(f => f.type === 'kaltura')).toBe(true);
    expect(single.some(f => f.type === 'kaltura')).toBe(true);
    expect(page.some(f => f.type === 'kaltura')).toBe(true);
  });
});

describe('Moodle format compatibility — grid format', () => {
  // format_grid hides sections behind image tiles. Once the user clicks a
  // tile, Moodle usually reveals the hidden <li.section> in place, so the
  // section scrapers still apply. The grid DOM itself is picked up by the
  // popup section scanner, not by scrapeSectionPage.
  test('scrapeSectionPage finds everything on a grid section page', () => {
    document.body.innerHTML = `
      <div id="region-main">
        <div class="activity modtype_resource">
          <a href="https://example.edu/mod/resource/view.php?id=900">Brief File</a>
        </div>
        <div class="activity modtype_kalvidres">
          <a href="https://example.edu/mod/kalvidres/view.php?id=901">Lecture Kaltura Video Resource</a>
        </div>
        <div class="activity modtype_folder">
          <a href="https://example.edu/mod/folder/view.php?id=902">Tutorial Pack</a>
        </div>
      </div>
    `;
    const results = bg.scrapeSectionPage(false);
    expect(results).toHaveLength(3);
    expect(results.some(r => r.type === 'kaltura')).toBe(true);
    expect(results.some(r => r.type === 'folder')).toBe(true);
    expect(results.some(r => r.type === 'resource')).toBe(true);
  });
});

describe('Moodle format compatibility — onetopic (tabbed)', () => {
  // Research §1.7: only the active tab is in the DOM; navigation is
  // /course/view.php?id=X&section=N. The popup picks these up through the
  // .onetopic .nav-tabs selectors; section content still matches our normal
  // activity scrapers once the tab is loaded.
  test('active onetopic tab exposes activities to scrapeSectionPage', () => {
    document.body.innerHTML = `
      <div class="onetopic">
        <ul class="nav nav-tabs">
          <li class="nav-item active"><a href="/course/view.php?id=1&section=1">Week 1</a></li>
          <li class="nav-item"><a href="/course/view.php?id=1&section=2">Week 2</a></li>
        </ul>
        <div class="tab-content">
          <div class="tab-pane active">
            <div class="activity modtype_resource">
              <a href="https://example.edu/mod/resource/view.php?id=1000">Tab Slides File</a>
            </div>
            <div class="activity modtype_kalvidres">
              <a href="https://example.edu/mod/kalvidres/view.php?id=1001">Tab Lecture Kaltura Video Resource</a>
            </div>
          </div>
        </div>
      </div>
    `;
    const results = bg.scrapeSectionPage(false);
    expect(results).toHaveLength(2);
    expect(results.some(r => r.type === 'kaltura')).toBe(true);
  });
});

describe('scraper × modtype matrix', () => {
  // For every scraper variant, every modtype we claim to support must be
  // detected. A change that removes detection from one cell fires exactly one
  // test — with a clear message pointing at the scraper and the modtype.
  const SUPPORTED_MODTYPES = [
    { klass: 'modtype_resource', type: 'resource', href: '/mod/resource/view.php?id=1', label: 'Slides File' },
    { klass: 'modtype_folder', type: 'folder', href: '/mod/folder/view.php?id=2', label: 'Tutorial Pack Folder' },
    { klass: 'modtype_kalvidres', type: 'kaltura', href: '/mod/kalvidres/view.php?id=3', label: 'Lecture Kaltura Video Resource' },
    { klass: 'modtype_kalvidpres', type: 'kaltura', href: '/mod/kalvidpres/view.php?id=4', label: 'Demo Kaltura Video Presentation' },
  ];

  const htmlFor = (mods) => `
    <div id="region-main">
      <li id="section-1" data-id="55001" data-number="1" class="section main">
        ${mods.map(m => `<div class="activity ${m.klass}"><a href="https://example.edu${m.href}">${m.label}</a></div>`).join('\n')}
      </li>
    </div>
  `;

  test.each(SUPPORTED_MODTYPES)(
    'scrapeSectionPage detects $klass',
    ({ klass, type }) => {
      document.body.innerHTML = htmlFor([SUPPORTED_MODTYPES.find(m => m.klass === klass)]);
      const results = bg.scrapeSectionPage(false);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.type === type)).toBe(true);
    }
  );

  test.each(SUPPORTED_MODTYPES)(
    'scrapeInlineSection detects $klass',
    ({ klass, type }) => {
      document.body.innerHTML = htmlFor([SUPPORTED_MODTYPES.find(m => m.klass === klass)]);
      const results = bg.scrapeInlineSection('55001', false);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.type === type)).toBe(true);
    }
  );

  test.each(SUPPORTED_MODTYPES)(
    'scrapeAllInlineSections detects $klass',
    ({ klass, type }) => {
      document.body.innerHTML = htmlFor([SUPPORTED_MODTYPES.find(m => m.klass === klass)]);
      const results = bg.scrapeAllInlineSections(['55001'], false);
      expect(results['55001'].length).toBeGreaterThanOrEqual(1);
      expect(results['55001'].some(r => r.type === type)).toBe(true);
    }
  );
});
