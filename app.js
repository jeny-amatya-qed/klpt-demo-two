
/*
  Developer notes:
  - Metadata normalization is required because the real `domains.json` mixes structures
    (`subDomains`, direct `elements`, and nested `elements`).
  - Accordions keep multiple selected Key Elements readable on tablet portrait.
  - Circular descriptor selection lets behaviour options be scanned quickly.
  - Tablet portrait (iPad-style) was the primary layout target.
  - Local-only storage (`localStorage`) for draft demo persistence.

  Changes vs original:
  1. Brand colours from logo mapped to domains/subdomains/key-elements/behaviours
     via DOMAIN_COLOR_MAP (ordered by domain index so each domain always gets a
     distinct logo colour).
  2. Carousel fix: clicking a behaviour node now reliably marks it as selected when
     it is the centred (is-center) node, and the `updateCenter` debounce prevents
     race-conditions between scroll-settle and click.
  3. Step 3 form is reorganised into clean labelled sections; observer's name uses
     a <datalist> populated from educators.json; learner code uses a <select>.
  4. Save/Print: learnerCode is now captured from the select before saving so it
     never falls back to the first CODE_OPTION; learnerCode + timestamp shown in
     a session-meta bar near the stepper.
  5. Saved-session list in both Home and Step 5 is grouped by observer name.
*/

const STEP_LABELS = [
  "Choose Learning Areas",
  "Select Observable Behaviours",
  "Fill Summary",
  "Review and Print"
];

const STORAGE_KEY = "klpt_demo_v1";

/*
  Ordered list of brand colours taken from the logo (orange, green, pink, red, blue).
  We cycle through these for each domain in index order so the colour is stable.
*/
const BRAND_COLOR_PAIRS = [
  { accent: "#F6861F", deep: "#AC5E16" },  // orange
  { accent: "#2A953C", deep: "#1D682A" },  // green
  { accent: "#EA0B8C", deep: "#A40862" },  // pink/magenta
  { accent: "#CF2027", deep: "#91161B" },  // red
  { accent: "#0077C1", deep: "#005387" },  // blue
  { accent: "#FFC000", deep: "#DF9528" },  // yellow
  { accent: "#B457D0", deep: "#683378" },  // purple
  { accent: "#31A790", deep: "#1A584C" },  // teal
  { accent: "#BC843A", deep: "#663300" }   // gold
];

const CODE_OPTIONS = [
  "Red Watermelon", "Blue Whale", "Green Turtle", "Golden Lion",
  "Pink Flamingo", "Silver Dolphin", "Purple Panda", "Orange Fox",
  "Teal Koala", "Ruby Sparrow", "Amber Tiger", "Coral Seahorse",
  "Indigo Owl", "Mint Gecko", "Crimson Rabbit", "Berry Penguin"
];

const state = {
  view: "home",
  currentStep: 1,
  domainsRaw: [],
  normalizedKeyElements: [],
  // Maps domainId -> colour pair, built once domains are loaded
  domainColorMap: {},
  selectedKeyElementIds: [],
  activePreviewByKeyElementId: {},
  selectedBehaviourByKeyElementId: {},
  usedCodes: new Set(),
  codeOptions: [],
  summaryForm: {
    learnerCode: "",
    sessionLabel: "",
    observationDate: getTodayISO(),
    childName: "",
    observerName: "",
    domainSummary: "",
    contextEvidence: "",
    observedText: "",
    nextStepText: "",
    professionalReflection: "",
    practiceSupportLink: "",
    supportLearning: "",
    supportLearningLink: "",
    summaryStyle: "option1",
    autoSummary: "",
    keyObservations: "",
    strengthsObserved: "",
    supportAreas: "",
    educatorNotes: "",
    teachingResponse: "",
    confidence: "",
    },
  savedDrafts: [],
  openDomainIds: {},
  selectedDomainId: "",
  selectedGroupKey: "",
  openGroupKeys: {},
  openBehaviourAccordionId: "",
  loading: true,
  loadError: "",
  validationMessage: "",
  sessionId: createSessionId(),
  autoSaveEnabled: false,
  autoSaveTimer: null,
  // Educator names loaded from educators.json
  educatorNames: [],
  // Track which saved session is currently loaded (updates instead of duplicates)
  loadedSessionIndex: null
};

const el = {
  stepper:     document.getElementById("stepper"),
  sessionMeta: document.getElementById("sessionMeta"),
  main:        document.getElementById("mainContent"),
  sticky:      document.getElementById("stickyActions")
};

init();

async function init() {
  state.savedDrafts = loadSavedDrafts();
  render();

  // Load educators list (non-fatal)
  try {
    const eduRes = await fetch("./educators.json", { cache: "no-store" });
    if (eduRes.ok) {
      const eduJson = await eduRes.json();
      state.educatorNames = Array.isArray(eduJson.educators) ? eduJson.educators : [];
    }
  } catch (_) { /* silently ignore */ }

  // Load learner code options from data folder (non-fatal)
  try {
    const codeRes = await fetch("./data/codes.json", { cache: "no-store" });
    if (codeRes.ok) {
      const codeJson = await codeRes.json();
      state.codeOptions = Array.isArray(codeJson.codes) ? codeJson.codes : CODE_OPTIONS;
    }
  } catch (_) {
    state.codeOptions = CODE_OPTIONS;
  }

  try {
    const res = await fetch("./domains.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch domains.json (${res.status})`);

    const json = await res.json();
    const domains = Array.isArray(json?.domains) ? json.domains : [];
    state.domainsRaw = sortByIndex(domains);
    state.normalizedKeyElements = normalizeDomains(state.domainsRaw);
    buildDomainColorMap();
    setupInitialOpenStates();
    state.loading = false;
    render();
  } catch (error) {
    state.loading = false;
    state.loadError = error.message || "Unknown loading error";
    render();
  }
  
  bindNavigation();
}

/* ── Colour Map ───────────────────────────────────────────────────── */

function buildDomainColorMap() {
  // Assign colours by domain index order so the same domain always gets
  // the same brand colour regardless of how many times render() is called.
  const sorted = [...state.domainsRaw].sort((a, b) =>
    (a.index ?? 9999) - (b.index ?? 9999)
  );
  sorted.forEach((domain, i) => {
    state.domainColorMap[domain.id] = BRAND_COLOR_PAIRS[i % BRAND_COLOR_PAIRS.length];
  });
}

function getDomainColors(domainId) {
  if (state.domainColorMap[domainId]) return state.domainColorMap[domainId];
  // Fallback for subdomains — look up via parent domain
  const record = state.normalizedKeyElements.find(r => r.domainId === domainId);
  if (record && state.domainColorMap[record.domainId]) {
    return state.domainColorMap[record.domainId];
  }
  // Hash fallback (original behaviour)
  const index = Math.abs(simpleHash(domainId || "default")) % BRAND_COLOR_PAIRS.length;
  return BRAND_COLOR_PAIRS[index];
}

/* ── Modal Dialog Helpers ──────────────────────────────────────────── */

function showConfirm(title, message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirmModal");
    const titleEl = document.getElementById("confirmTitle");
    const msgEl = document.getElementById("confirmMessage");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");
    
    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.classList.remove("hidden");
    
    const handleOk = () => {
      cleanup();
      resolve(true);
    };
    
    const handleCancel = () => {
      cleanup();
      resolve(false);
    };
    
    const handleOverlayClick = (e) => {
      if (e.target.classList.contains("modal-overlay")) {
        cleanup();
        resolve(false);
      }
    };
    
    const cleanup = () => {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", handleOk);
      cancelBtn.removeEventListener("click", handleCancel);
      modal.removeEventListener("click", handleOverlayClick);
    };
    
    okBtn.addEventListener("click", handleOk);
    cancelBtn.addEventListener("click", handleCancel);
    modal.addEventListener("click", handleOverlayClick);
  });
}

function showAlert(title, message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("alertModal");
    const titleEl = document.getElementById("alertTitle");
    const msgEl = document.getElementById("alertMessage");
    const okBtn = document.getElementById("alertOkBtn");
    
    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.classList.remove("hidden");
    
    const handleOk = () => {
      cleanup();
      resolve();
    };
    
    const handleOverlayClick = (e) => {
      if (e.target.classList.contains("modal-overlay")) {
        cleanup();
        resolve();
      }
    };
    
    const cleanup = () => {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", handleOk);
      modal.removeEventListener("click", handleOverlayClick);
    };
    
    okBtn.addEventListener("click", handleOk);
    modal.addEventListener("click", handleOverlayClick);
  });
}

/* ── Domain Normalisation ─────────────────────────────────────────── */

function normalizeDomains(domains) {
  const normalized = [];
  sortByIndex(domains).forEach(domain => {
    const domainMeta = {
      domainId: domain.id,
      domainName: domain.name || "Unnamed Domain",
      domainSummary: domain.summary || "",
      domainIndex: domain.index
    };
    if (Array.isArray(domain.subDomains) && domain.subDomains.length) {
      sortByIndex(domain.subDomains).forEach(subDomain => {
        walkElements({ normalized, domainMeta, subdomain: subDomain,
          elements: sortByIndex(subDomain.elements || []), parentChain: [] });
      });
      return;
    }
    if (Array.isArray(domain.elements) && domain.elements.length) {
      walkElements({ normalized, domainMeta, subdomain: null,
        elements: sortByIndex(domain.elements || []), parentChain: [] });
    }
  });
  return normalized.sort((a, b) => {
    const ai = [a.domainIndex, a.subdomainIndex, a.parentElementIndex, a.keyElementIndex]
      .map(v => (typeof v === "number" ? v : 9999));
    const bi = [b.domainIndex, b.subdomainIndex, b.parentElementIndex, b.keyElementIndex]
      .map(v => (typeof v === "number" ? v : 9999));
    for (let i = 0; i < ai.length; i++) {
      if (ai[i] !== bi[i]) return ai[i] - bi[i];
    }
    return (a.keyElementName || "").localeCompare(b.keyElementName || "");
  });
}

function walkElements({ normalized, domainMeta, subdomain, elements, parentChain }) {
  sortByIndex(elements).forEach(element => {
    const behaviours = sortByIndex(element.behaviours || []);
    if (behaviours.length) {
      const directParent = parentChain.length ? parentChain[parentChain.length - 1] : null;
      normalized.push({
        domainId:           domainMeta.domainId,
        domainName:         domainMeta.domainName,
        domainSummary:      domainMeta.domainSummary,
        domainIndex:        domainMeta.domainIndex,
        subdomainId:        subdomain?.id,
        subdomainName:      subdomain?.name,
        subdomainIndex:     subdomain?.index,
        parentElementId:    directParent?.id,
        parentElementName:  directParent?.name,
        parentElementIndex: directParent?.index,
        keyElementId:       element.id,
        keyElementName:     element.name || "Unnamed Key Element",
        keyElementIndex:    element.index,
        behaviours: behaviours.map(b => ({
          id: b.id, index: b.index,
          name: b.name || "Unnamed level",
          description: b.description || ""
        }))
      });
    }
    if (Array.isArray(element.elements) && element.elements.length) {
      walkElements({ normalized, domainMeta, subdomain,
        elements: sortByIndex(element.elements),
        parentChain: [...parentChain, element] });
    }
  });
}

function setupInitialOpenStates() {
  const first = state.domainsRaw[0];
  if (first?.id) state.openDomainIds[first.id] = true;
}

/* ── Render Root ─────────────────────────────────────────────────── */

function render() {
  renderSessionMeta();
  renderStepper();
  renderMain();
  renderStickyActions();
  updateNavigationActive();
}

/* ── Session Meta Bar ────────────────────────────────────────────── */

function renderSessionMeta() {
  if (state.view === "home" || state.view === "using-klpt" || state.view === "learning-domains-tools" || 
      state.view === "foundations" || state.view === "observation-support" || state.loading || state.loadError ||
      (!state.summaryForm.learnerCode && !state.observationStartedAt)) {
    el.sessionMeta.classList.add("hidden");
    el.sessionMeta.innerHTML = "";
    return;
  }
  el.sessionMeta.classList.remove("hidden");
  const codeIcon = state.summaryForm.learnerCode
    ? getCodeIcon(state.summaryForm.learnerCode) : "";
  const codeLabel = state.summaryForm.learnerCode || "No code set";
  const timeLabel = state.observationStartedAt
    ? `Started ${formatDateTime(state.observationStartedAt)}` : "";
  el.sessionMeta.innerHTML = `
    <span class="meta-chip code-chip">
      <span class="meta-icon">${codeIcon}</span>
      ${escapeHtml(codeLabel)}
    </span>
    ${timeLabel ? `<span class="meta-chip"><span class="meta-icon">🕐</span>${escapeHtml(timeLabel)}</span>` : ""}
  `;
}

/* ── Stepper ─────────────────────────────────────────────────────── */

function renderStepper() {
  if (state.view !== "flow" || state.loading || state.loadError) {
    el.stepper.classList.add("hidden");
    el.stepper.innerHTML = "";
    return;
  }
  el.stepper.classList.remove("hidden");
  const maxUnlocked = getMaxUnlockedStep();
  el.stepper.innerHTML = STEP_LABELS.map((label, idx) => {
    const step = idx + 1;
    const isActive   = state.currentStep === step;
    const isComplete = step < state.currentStep && isStepComplete(step);
    const isLocked   = step > maxUnlocked;
    return `
      <button type="button"
        class="step-item ${isActive ? "active" : ""} ${isComplete ? "complete" : ""} ${isLocked ? "locked" : ""}"
        data-step="${step}"
        aria-label="Go to step ${step}: ${escapeHtml(label)}"
        aria-current="${isActive ? "step" : "false"}">
        <span class="step-dot">${isComplete ? "&#10003;" : step}</span>
        <span class="step-label">${escapeHtml(label)}</span>
      </button>
    `;
  }).join("");
  Array.from(el.stepper.querySelectorAll(".step-item")).forEach(btn => {
    btn.addEventListener("click", () => tryNavigateToStep(Number(btn.dataset.step)));
  });
}

/* ── Main Router ─────────────────────────────────────────────────── */

function renderMain() {
  if (state.loading) { el.main.innerHTML = document.getElementById("loadingTemplate").innerHTML; return; }
  if (state.loadError) { el.main.innerHTML = document.getElementById("errorTemplate").innerHTML; return; }
  if (state.view === "home") { renderHome(); return; }
  if (state.view === "using-klpt") { renderUsingKLPT(); return; }
  if (state.view === "learning-domains-tools") { renderLearningDomainsTools(); return; }
  if (state.view === "foundations") { renderFoundations(); return; }
  if (state.view === "observation-support") { renderObservationSupport(); return; }
  if      (state.currentStep === 1) renderStep1();
  else if (state.currentStep === 2) renderStep2();
  else if (state.currentStep === 3) renderStep3();
  else if (state.currentStep === 4) renderStep4();
  else                              renderStep4();
}

/* ── Sticky Actions ──────────────────────────────────────────────── */

function renderStickyActions() {
  if (state.loading || state.loadError || state.view === "home" || state.view === "using-klpt" || 
      state.view === "learning-domains-tools" || state.view === "foundations" || state.view === "observation-support") {
    el.sticky.innerHTML = ""; return;
  }
  const canGoBack = state.currentStep > 1;

  el.sticky.innerHTML = `
    <div class="sticky-inner">
      <div class="sticky-left"></div>
      <div class="sticky-right">
        <label class="autosave-toggle" title="Auto-save your progress every 10 seconds">
          <input id="autoSaveToggle" type="checkbox" ${state.autoSaveEnabled ? "checked" : ""} />
          <span>Auto-save</span>
        </label>
        <button class="btn ghost" type="button" id="saveNowBtn" title="Save your progress now">💾 Save</button>
        ${canGoBack ? '<button class="btn secondary" type="button" id="backBtn">← Back</button>' : ""}
        ${state.currentStep < 4
          ? '<button class="btn primary" type="button" id="nextBtn">Next →</button>'
          : '<button class="btn primary" type="button" id="finishBtn">✓ Finish</button>'}
      </div>
    </div>
  `;

  document.getElementById("saveNowBtn")?.addEventListener("click", () => {
    saveCurrentDraft();
    showAlert("Saved", "Your observation has been saved successfully.");
  });

  document.getElementById("autoSaveToggle")?.addEventListener("change", e => {
    state.autoSaveEnabled = !!e.target.checked;
    if (state.autoSaveEnabled) { 
      startAutoSaveTimer(); 
      saveCurrentDraft();
      const toggle = document.getElementById("autoSaveToggle");
      if (toggle) toggle.parentElement.classList.add("auto-save-enabled");
    }
    else { 
      stopAutoSaveTimer();
      const toggle = document.getElementById("autoSaveToggle");
      if (toggle) toggle.parentElement.classList.remove("auto-save-enabled");
    }
  });

  document.getElementById("backBtn")?.addEventListener("click", () => {
    state.validationMessage = "";
    state.currentStep -= 1;
    render(); focusMain();
  });

  document.getElementById("nextBtn")?.addEventListener("click", () => {
    tryNavigateToStep(Math.min(STEP_LABELS.length, state.currentStep + 1));
  });

  document.getElementById("finishBtn")?.addEventListener("click", () => {
    saveCurrentDraft();
    state.view = "observation-support";
    state.currentStep = 1;
    resetCurrentSession();
    render();
    focusMain();
  });
}

/* ── Navigation Binding ────────────────────────────────────────────── */

function bindNavigation() {
  // Bind vertical navigation buttons
  Array.from(document.querySelectorAll(".vertical-nav-btn")).forEach(btn => {
    btn.addEventListener("click", () => {
      const navView = btn.dataset.nav;
      if (navView === "home") {
        state.view = "home";
        state.currentStep = 1;
      } else if (navView === "learning-domains-tools") {
        state.view = "learning-domains-tools";
      } else if (navView === "foundations") {
        state.view = "foundations";
      }
      render();
      focusMain();
    });
  });

  // Bind horizontal tab buttons
  Array.from(document.querySelectorAll(".tab-btn")).forEach(btn => {
    btn.addEventListener("click", () => {
      const tabView = btn.dataset.tab;
      if (tabView === "observation-support") {
         state.view = "observation-support";
        //state.view = "home";
        //state.currentStep = 1;
      } else if (tabView === "using-klpt") {
        state.view = "using-klpt";
      } else if (tabView === "learning-domains") {
        state.view = "learning-domains-tools";
      } else if (tabView === "practice-support") {
        // TODO: Implement practice-support view
        state.view = "learning-domains-tools"; // Fallback for now
      }
      render();
      focusMain();
    });
  });
}

function updateNavigationActive() {
  // Update vertical nav active state
  Array.from(document.querySelectorAll(".vertical-nav-btn")).forEach(btn => {
    btn.classList.remove("active");
    const navView = btn.dataset.nav;
    if ((navView === "home" && state.view === "home") ||
        (navView === "learning-domains-tools" && state.view === "learning-domains-tools") ||
        (navView === "foundations" && state.view === "foundations")) {
      btn.classList.add("active");
    }
  });

  // Update horizontal tab active state
  Array.from(document.querySelectorAll(".tab-btn")).forEach(btn => {
    btn.classList.remove("active");
    const tabView = btn.dataset.tab;
    if ((tabView === "observation-support" && state.view === "home") ||
        (tabView === "using-klpt" && state.view === "using-klpt") ||
        (tabView === "learning-domains" && state.view === "learning-domains-tools")) {
      btn.classList.add("active");
    }
  });
}

/* ── Home ────────────────────────────────────────────────────────── */

function groupDraftsByObserver(drafts) {
  const groups = new Map();
  drafts.forEach(draft => {
    const observer = draft.summaryForm?.observerName?.trim() || "Unknown Observer";
    if (!groups.has(observer)) groups.set(observer, []);
    groups.get(observer).push(draft);
  });
  return groups;
}

function renderHome() {
  el.main.innerHTML = `
    <section class="panel home-panel">
      <div class="home-container">       

        <!-- Video Section -->
        <div class="home-video-section">
          <div class="video-area">
            <div class="video-placeholder-dark">
              <div class="play-button">▶</div>
              <div class="video-label">An Introduction to the KLPT</div>
            </div>
            <p class="video-guide-text">KLPT User Guide (downloadable PDF)</p>
          </div>
        </div>

        <!-- Navigation Links Grid -->
        <div class="home-nav-grid">
          <button type="button" class="nav-box nav-box-primary" id="foundationsBtn">
            <h3>Foundations</h3>
            <p>(Summary text)</p>
            <p class="nav-link-hint">(Link)</p>
          </button>
          <button type="button" class="nav-box nav-box-primary" id="learningDomainsBtn">
            <h3>Learning domains and observation support tool</h3>
            <p>(Summary text)</p>
            <p class="nav-link-hint">(Link)</p>
          </button>
        </div>

        <!-- Acknowledgements Box -->
        <div class="home-content-box acknowledgements-box">
          <h3>Acknowledgements</h3>
          <p>(Summary text) (Link)</p>
          <p class="secondary-text">Either link to acknowledgements page, popup text box, or drop-down text</p>
        </div>
      </div>
    </section>
  `;

  // Bind navigation buttons
  document.getElementById("foundationsBtn")?.addEventListener("click", () => {
    state.view = "foundations";
    render();
    focusMain();
  });

  document.getElementById("learningDomainsBtn")?.addEventListener("click", () => {
    state.view = "learning-domains-tools";
    render();
    focusMain();
  });
}

/* ── Using the KLPT ────────────────────────────────────────────── */

function renderUsingKLPT() {
  el.main.innerHTML = `
    <section class="panel info-panel">
      <h2>Using the KLPT</h2>
      <p class="info-intro">
        The KLPT in everyday practice is a tool for educators to systematically observe and document children's 
        learning across the five key learning domains. This guide shows you how to get started and make the most 
        of the tool's features.
      </p>
      
      <div class="video-section">
        <div class="video-placeholder">
          <svg viewBox="0 0 400 225" xmlns="http://www.w3.org/2000/svg">
            <rect width="400" height="225" fill="#e8eef7"/>
            <circle cx="200" cy="112.5" r="40" fill="#0077c1" opacity="0.8"/>
            <polygon points="185,95 185,130 220,112.5" fill="white"/>
          </svg>
          <p class="video-label">Watch the KLPT Introduction</p>
        </div>
        <div class="video-links">
          <a href="#transcript" class="link-btn">View Transcript</a>
          <a href="./klpt-user-guide.pdf" download class="link-btn primary">Download PDF Guide</a>
        </div>
      </div>
      
      <div class="info-content">
        <h3>Key Features</h3>
        <ul>
          <li><strong>Learn the domains:</strong> Understand the five key learning domains and how they develop</li>
          <li><strong>Observe behaviours:</strong> Identify and document specific observable behaviours</li>
          <li><strong>Record evidence:</strong> Capture contextual notes and observations</li>
          <li><strong>Generate reports:</strong> Create summaries and learning progression statements</li>
          <li><strong>Save your work:</strong> Store observations securely and revisit them anytime</li>
        </ul>
      </div>
    </section>
  `;
}

/* ── Learning Domains & Tools ────────────────────────────────────── */

function renderLearningDomainsTools() {
  el.main.innerHTML = `
    <section class="panel">
      <h2>Learning Domains & Tool Resources</h2>
      <p class="section-subtitle">Explore the five key learning domains and access support resources.</p>
      
      <div class="domains-resources">
        <div class="resource-card">
          <h3>📚 Language and Literacy</h3>
          <p>Develops from birth through communication, vocabulary building, and early literacy skills.</p>
        </div>
        <div class="resource-card">
          <h3>🧠 Executive Function</h3>
          <p>Building self-regulation, planning, memory, and the ability to manage learning.</p>
        </div>
        <div class="resource-card">
          <h3>💝 Social and Emotional Learning</h3>
          <p>Growing emotional awareness, relationships, empathy, and social skills.</p>
        </div>
        <div class="resource-card">
          <h3>🏃 Physicality</h3>
          <p>Development of gross and fine motor skills, coordination, and physical awareness.</p>
        </div>
        <div class="resource-card">
          <h3>🔢 Mathematics and Numeracy</h3>
          <p>Building mathematical thinking, number sense, and problem-solving skills.</p>
        </div>
      </div>
      
      <div class="action-row" style="margin-top:24px;">
        <button class="btn primary" id="startObservationBtn">Start an Observation</button>
      </div>
    </section>
  `;
  
  document.getElementById("startObservationBtn")?.addEventListener("click", () => {
    showCodeSelectionModal();
  });
}

/* ── Foundations ───────────────────────────────────────────────── */

function renderFoundations() {
  el.main.innerHTML = `
    <section class="panel">
      <h2>Foundations</h2>
      <p class="section-subtitle">Learn about the foundational principles of child development and learning.</p>
      
      <div class="foundations-content">
        <div class="foundation-section">
          <h3>Development Progressions</h3>
          <p>Understanding how children develop across different domains and what progression looks like at different ages and stages.</p>
          <a href="#" class="link-btn">Learn More</a>
        </div>
        
        <div class="foundation-section">
          <h3>Frequently Asked Questions</h3>
          <p>Find answers to common questions about the KLPT, child development, and practical implementation.</p>
          <a href="#" class="link-btn">Visit FAQ</a>
        </div>
        
        <div class="foundation-section">
          <h3>Contact us</h3>
          <p>Need additional support or have questions about the tool? Get in touch with our team.</p>
          <a href="#" class="link-btn">Contact Support</a>
        </div>
      </div>
    </section>
  `;
}

/* ── Observation Support Tool ───────────────────────────────────── */

function renderObservationSupport() {
  const drafts = state.savedDrafts || [];

  /*const sessionsHtml = drafts.length === 0
    ? `<p class="secondary-text">No saved sessions yet.</p>`
    : drafts.map((draft, idx) => `
        <div class="session-card">
          <p>
            <strong>
              ${escapeHtml(draft.summaryForm?.learnerCode || draft.sessionId)}
            </strong>
          </p>
          <small>${escapeHtml(new Date(draft.timestamp).toLocaleString())}</small>

          <div class="action-row">
            <button class="btn ghost" data-load-draft="${idx}">Load</button>
            <button class="btn warn" data-delete-draft="${idx}">Delete</button>
          </div>
        </div>
      `).join("");

  el.main.innerHTML = `
    <section class="panel">
      <h2>Observation Support Tool</h2>
      <p class="section-subtitle">       
      </p>     

      <div class="new-observation">
        <div class="plus-circle"  id="newObservationCircle">+</div>
          <div>
            <h2>Start a new observation</h2>
          <p>Tap + to begin.</p>
        </div>
      </div>    

      <h3>Saved Sessions (${drafts.length})</h3>
      <div class="session-list">
        ${sessionsHtml}
      </div>
    </section>
  `;*/

// Group drafts by observer name
const groups = groupDraftsByObserver(state.savedDrafts);
const deleteAllSessionsButton = state.savedDrafts.length
  ? `<button type="button" class="btn ghost small delete-all-sessions-btn">Delete all</button>`
  : "";
let sessionsHtml;

if (state.savedDrafts.length === 0) {
  sessionsHtml = `<p class="secondary-text">No saved sessions yet.</p>`;
} else {
  sessionsHtml = "";
  for (const [observer, groupDrafts] of groups) {
    sessionsHtml += `<div class="recent-group">
      <div class="recent-group-label">${escapeHtml(observer)}</div>
      <div class="recent-list">`;
    
    groupDrafts.forEach(draft => {
      const idx = state.savedDrafts.indexOf(draft);
      sessionsHtml += `
        <div class="recent-item session-card" data-load-draft="${idx}">
          <div class="session-card-content">
            <div class="session-card-title-row">
              <p><strong>${escapeHtml(getCodeIcon(draft.summaryForm?.learnerCode || ""))} ${escapeHtml(draft.summaryForm?.learnerCode || draft.summaryForm?.sessionLabel || draft.sessionId)}</strong></p>
              <small>${escapeHtml(formatDateTime(draft.timestamp))}</small>
            </div>
          </div>
          <button 
            type="button"
            class="icon-delete"
            data-delete-draft="${idx}"
            title="Delete session"
            aria-label="Delete ${escapeHtml(draft.summaryForm?.learnerCode || draft.sessionId)}"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>`;
    });

    sessionsHtml += `</div></div>`;
  }
}
el.main.innerHTML = `
  <section class="panel">
    <h2>Observation Support Tool</h2>
    <p class="section-subtitle"></p>     

    <div class="new-observation" id="newObservationBtn">
      <div class="new-observation-icon" id="newObservationCircle">
        <img src="./images/start-new-observation.svg" alt="Start a new observation" />
      </div>
      <div class="new-observation-copy">        
        <h2>Start a new observation</h2>        
      </div>
    </div>    

    <div class="session-panel-header">
      <h3>Saved Sessions (${drafts.length})</h3>
      ${deleteAllSessionsButton}
    </div>
    <div class="session-list">
      ${sessionsHtml}
    </div>
  </section>
`;
 /* const groups = groupDraftsByObserver(state.savedDrafts);

let sessionsHtml;
  if (!state.savedDrafts.length) {
    sessionsHtml = '<p class="meta">No saved sessions yet.</p>';
  } else {
    sessionsHtml = "";
    for (const [observer, groupDrafts] of groups) {
      sessionsHtml += `<div class="recent-group"><div class="recent-group-label">${escapeHtml(observer)}</div>`;
      groupDrafts.forEach(draft => {
        const idx = state.savedDrafts.indexOf(draft);
        sessionsHtml += `
          <div class="recent-item">
            <p><strong>${escapeHtml(getCodeIcon(draft.summaryForm?.learnerCode || ""))} ${escapeHtml(draft.summaryForm?.learnerCode || draft.summaryForm?.sessionLabel || draft.sessionId)}</strong></p>
            <small>${escapeHtml(formatDateTime(draft.timestamp))}</small>
            <div class="action-row">
              <button class="btn ghost" type="button" data-load-draft="${idx}">Load</button>
              <button class="btn warn"  type="button" data-delete-draft="${idx}">Delete</button>
            </div>
          </div>`;
      });
      sessionsHtml += `</div>`;
    }
  }

  el.main.innerHTML = `
    <section class="panel" aria-labelledby="step5Title">
      <h2 class="section-title" id="step5Title">Save / Print</h2>
      ${renderLearningBreadcrumbs()}

      <div class="action-row">
        <button class="btn primary"   type="button" id="saveDraftBtn">Save Draft</button>
        <button class="btn secondary" type="button" id="startNewBtn">Start New Observation</button>
        <button class="btn warn"      type="button" id="clearSessionBtn">Clear Session</button>
        <button class="btn ghost"     type="button" id="printBtn">Print / Export PDF</button>
        <button class="btn ghost"     type="button" id="exportJsonBtn">Export JSON</button>
      </div>

      <article class="review-card" style="margin-top:12px;">
        <h3>Saved sessions (${state.savedDrafts.length})</h3>
        <div class="recent-list">${sessionsHtml}</div>
      </article>
    </section>
  `;*/

  // ➕ New Observation
  document.getElementById("newObservationBtn")?.addEventListener("click", () => {
    showCodeSelectionModal();
  });

  document.getElementById("newObservationCircle")?.addEventListener("click", () => {
    showCodeSelectionModal();
  });

  Array.from(el.main.querySelectorAll(".delete-all-sessions-btn")).forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!state.savedDrafts.length) return;
      const confirmed = await showConfirm(
        "Delete all saved sessions",
        "Delete all saved sessions? This cannot be undone."
      );
      if (!confirmed) return;
      state.savedDrafts = [];
      persistDrafts();
      renderObservationSupport();
    });
  });

  // ▶ Load Draft
  Array.from(el.main.querySelectorAll("[data-load-draft]")).forEach(btn => {
    btn.addEventListener("click", () => {
      const draft = state.savedDrafts[Number(btn.dataset.loadDraft)];
      if (!draft) return;

      hydrateFromDraft(draft);
      state.currentStep = 4;
      state.view = "flow";
      render();
      focusMain();
    });
  });

  // 🗑 Delete Draft
  Array.from(el.main.querySelectorAll("[data-delete-draft]")).forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.deleteDraft);
      state.savedDrafts.splice(idx, 1);
      persistDrafts();
      renderObservationSupport();
    });
  });
}

/* ── Step 1 ──────────────────────────────────────────────────────── */

function renderStep1() {
  const model           = buildDomainViewModel();
  const selectedRecords = getSelectedKeyElementRecords();
  const scope           = getCurrentSelectionScope();
  const activeDomainId  = state.selectedDomainId || scope?.domainId || "";
  const activeDomain    = model.find(d => d.domainId === activeDomainId);
  const hasMultipleGroups = !!activeDomain && activeDomain.groups.length > 1;
  const desiredGroupKey = state.selectedGroupKey || scope?.groupKey || "";
  const activeGroup     = activeDomain?.groups.find(g => g.groupKey === desiredGroupKey)
                          || (!hasMultipleGroups ? activeDomain?.groups[0] : null);
  const activeGroupKey  = activeGroup?.groupKey || "";
  const keyItems        = activeGroup?.items || [];
  const showGroupSelector = !!activeDomain && activeDomain.groups.length > 0 && hasMultipleGroups;
  const showKeyElements   = !!activeDomain && (!showGroupSelector || !!activeGroup);

  el.main.innerHTML = `
    <section class="panel" aria-labelledby="step1Title">
      <h2 class="section-title" id="step1Title">Choose Learning Areas</h2>
      <p class="section-subtitle">Choose one domain, one sub-domain (if shown), and one or more key elements.</p>
      ${renderLearningBreadcrumbs()}
      ${state.validationMessage ? `<p class="validation" role="status">${escapeHtml(state.validationMessage)}</p>` : ""}

      <div class="compact-select">
        <p class="meta">Domain</p>
        <div class="chip-grid">
          ${model.map(domain => {
            const colors = getDomainColors(domain.domainId);
            return `<button type="button"
              class="chip ${domain.domainId === activeDomainId ? "selected" : ""}"
              data-select-domain="${domain.domainId}"
              style="--accent:${colors.accent}; --accent-deep:${colors.deep};"
              aria-pressed="${domain.domainId === activeDomainId ? "true" : "false"}">
              ${escapeHtml(domain.domainName)}
            </button>`;
          }).join("")}
        </div>

        ${showGroupSelector ? `
          <p class="meta" style="margin-top:10px;">Sub-domain / Group</p>
          <div class="chip-grid">
            ${activeDomain.groups.map(group => {
              const colors = getDomainColors(activeDomainId);
              return `<button type="button"
                class="chip ${group.groupKey === activeGroupKey ? "selected" : ""}"
                data-select-group="${escapeAttribute(group.groupKey)}"
                style="--accent:${colors.accent}; --accent-deep:${colors.deep};">
                ${escapeHtml(group.groupName)}
              </button>`;
            }).join("")}
          </div>
        ` : ""}

        ${showKeyElements ? `
          <p class="meta" style="margin-top:10px;">Key Elements</p>
          <div class="chip-grid">
            ${keyItems.map(item => {
              const colors = getDomainColors(item.domainId);
              const selected = state.selectedKeyElementIds.includes(item.keyElementId);
              return `<button type="button"
                class="chip ${selected ? "selected" : ""}"
                data-key-element-id="${item.keyElementId}"
                style="--accent:${colors.accent}; --accent-deep:${colors.deep};"
                aria-pressed="${selected ? "true" : "false"}">
                ${escapeHtml(item.keyElementName)}
              </button>`;
            }).join("")}
          </div>
        ` : activeDomain ? `
          <p class="meta" style="margin-top:10px;">Select a sub-domain to load key elements.</p>
        ` : `
          <p class="meta" style="margin-top:10px;">Select a domain to load options.</p>
        `}
      </div>

      <div class="selected-summary" style="display:none;" aria-live="polite">
        <h3>Selected Key Elements (${selectedRecords.length})</h3>
        <div class="selected-list">
          ${selectedRecords.length
            ? selectedRecords.map(r => `<span class="selected-item">${escapeHtml(r.domainName)}  |  ${escapeHtml(r.keyElementName)}</span>`).join("")
            : '<span class="selected-item">No Key Elements selected yet</span>'}
        </div>
      </div>
    </section>
  `;

  bindCompactSelectors(model);
  bindKeyElementChips();
}

function buildDomainViewModel() {
  const groupedByDomain = new Map();
  state.normalizedKeyElements.forEach(record => {
    if (!groupedByDomain.has(record.domainId)) {
      groupedByDomain.set(record.domainId, {
        domainId: record.domainId,
        domainName: record.domainName,
        domainSummary: record.domainSummary,
        domainIndex: record.domainIndex,
        groups: new Map()
      });
    }
    const domain   = groupedByDomain.get(record.domainId);
    const groupKey = record.subdomainId   ? `sub:${record.subdomainId}`
                   : record.parentElementId ? `parent:${record.parentElementId}`
                   : `direct:${record.domainId}`;
    const groupName = record.subdomainName || record.parentElementName || "Key Elements";
    if (!domain.groups.has(groupKey)) {
      domain.groups.set(groupKey, {
        groupKey, groupName,
        groupOrder: record.subdomainIndex ?? record.parentElementIndex ?? 9999,
        items: []
      });
    }
    domain.groups.get(groupKey).items.push(record);
  });
  return Array.from(groupedByDomain.values())
    .sort((a, b) => (a.domainIndex ?? 9999) - (b.domainIndex ?? 9999))
    .map(domain => ({
      ...domain,
      groups: Array.from(domain.groups.values())
        .sort((a, b) => (a.groupOrder ?? 9999) - (b.groupOrder ?? 9999))
        .map(g => ({ ...g, items: g.items.sort((a, b) => (a.keyElementIndex ?? 9999) - (b.keyElementIndex ?? 9999)) }))
    }));
}

function bindCompactSelectors(model) {
  Array.from(el.main.querySelectorAll("[data-select-domain]")).forEach(btn => {
    btn.addEventListener("click", () => {
      const domainId = btn.dataset.selectDomain;
      if (state.selectedDomainId === domainId) return;
      state.openDomainIds       = { [domainId]: true };
      state.selectedDomainId    = domainId;
      state.selectedKeyElementIds = [];
      state.selectedBehaviourByKeyElementId = {};
      state.activePreviewByKeyElementId = {};
      state.selectedGroupKey    = "";
      state.validationMessage   = "";
      renderStep1(); renderStickyActions(); renderStepper();
    });
  });

  Array.from(el.main.querySelectorAll("[data-select-group]")).forEach(btn => {
    btn.addEventListener("click", () => {
      const groupKey = btn.dataset.selectGroup;
      const domain = model.find(d => d.domainId === state.selectedDomainId);
      const targetGroup = domain?.groups.find(g => g.groupKey === groupKey);
      if (!targetGroup || state.selectedGroupKey === groupKey) return;
      state.selectedKeyElementIds = [];
      state.selectedBehaviourByKeyElementId = {};
      state.activePreviewByKeyElementId = {};
      state.selectedGroupKey  = groupKey;
      state.validationMessage = "";
      const scopeRecord = targetGroup.items[0];
      if (scopeRecord) {
        state.selectedDomainId = scopeRecord.domainId;
        state.openDomainIds = { [scopeRecord.domainId]: true };
      }
      renderStep1(); renderStickyActions(); renderStepper();
    });
  });
}

function bindKeyElementChips() {
  Array.from(el.main.querySelectorAll("[data-key-element-id]")).forEach(chip => {
    chip.addEventListener("click", () => {
      const keyElementId = chip.dataset.keyElementId;
      const record = state.normalizedKeyElements.find(r => r.keyElementId === keyElementId);
      if (!record) return;
      const exists = state.selectedKeyElementIds.includes(keyElementId);
      if (exists) {
        state.selectedKeyElementIds = state.selectedKeyElementIds.filter(id => id !== keyElementId);
      } else {
        const currentScope = getCurrentSelectionScope();
        const clickedScope = getScopeFromRecord(record);
        state.selectedDomainId = clickedScope.domainId;
        state.openDomainIds = { [record.domainId]: true };
        state.selectedGroupKey = clickedScope.groupKey;
        if (currentScope && (currentScope.domainId !== clickedScope.domainId || currentScope.groupKey !== clickedScope.groupKey)) {
          state.selectedKeyElementIds = [keyElementId];
          state.validationMessage = "Selection scope changed. Keeping one domain and one sub-domain as requested.";
        } else {
          state.selectedKeyElementIds = [...state.selectedKeyElementIds, keyElementId];
        }
      }
      reconcileDependentSelections();
      if (!state.validationMessage) state.validationMessage = "";
      renderStep1(); renderStickyActions(); renderStepper();
    });
  });
}

/* ── Step 2 ──────────────────────────────────────────────────────── */

function renderStep2() {
  const selectedRecords = getSelectedKeyElementRecords();
  const pendingCount    = selectedRecords.filter(r => !state.selectedBehaviourByKeyElementId[r.keyElementId]).length;

  if (!selectedRecords.length) {
    el.main.innerHTML = `
      <section class="panel">
        <h2 class="section-title">Select Observable Behaviours</h2>
        <p class="validation">Select at least one Key Element in Step 1 before choosing behaviours.</p>
      </section>`;
    return;
  }

  ensurePreviewSelections(selectedRecords);

  if (!state.openBehaviourAccordionId || !selectedRecords.some(r => r.keyElementId === state.openBehaviourAccordionId)) {
    state.openBehaviourAccordionId = selectedRecords[0].keyElementId;
  }

  el.main.innerHTML = `
    <section class="panel" aria-labelledby="step2Title">
      <h2 class="section-title" id="step2Title">Select Observable Behaviours</h2>
      ${renderLearningBreadcrumbs()}
      <p class="section-subtitle">${pendingCount > 0 ? `${pendingCount} remaining to select.` : "All selected."}</p>
      ${state.validationMessage ? `<p class="validation" role="status">${escapeHtml(state.validationMessage)}</p>` : ""}
      ${selectedRecords.map(record => renderBehaviourAccordion(record)).join("")}
    </section>
  `;

  bindBehaviourAccordions();
  bindLevelButtons();
  bindBehaviourCarouselFocus();
  bindBehaviourCarouselControls();
}

function renderBehaviourAccordion(record) {
  const isOpen             = record.keyElementId === state.openBehaviourAccordionId;
  const selectedBehaviourId = state.selectedBehaviourByKeyElementId[record.keyElementId] || "";
  const selectedBehaviour  = record.behaviours.find(b => b.id === selectedBehaviourId);
  const colors             = getDomainColors(record.domainId);
  const selectedBadge      = selectedBehaviour ? selectedBehaviour.name : "Not selected";

  const activePreviewId = state.activePreviewByKeyElementId[record.keyElementId] || record.behaviours[0]?.id;
  const previewBehaviour = record.behaviours.find(b => b.id === activePreviewId) || record.behaviours[0];
  const loopPad  = record.behaviours.length > 1 ? Math.min(2, Math.max(1, record.behaviours.length - 1)) : 0;
  const loopItems = buildLoopBehaviours(record.behaviours, loopPad);
  const behaviourOrder = record.behaviours.map(b => b.id).join("|");

  return `
    <article class="accordion ${isOpen ? "open" : ""}"
      data-beh-accordion="${record.keyElementId}"
      style="--accent:${colors.accent}; --accent-deep:${colors.deep};">
      <button class="accordion-header" type="button"
        aria-expanded="${isOpen ? "true" : "false"}"
        aria-label="Toggle behaviour section for ${escapeHtml(record.keyElementName)}">
        <span>
          <strong>${escapeHtml(record.domainName)}${record.subdomainName ? `  |  ${escapeHtml(record.subdomainName)}` : ""}${record.parentElementName ? `  |  ${escapeHtml(record.parentElementName)}` : ""}</strong>
          <div class="meta">${escapeHtml(record.keyElementName)}</div>
        </span>
        <span class="badge ${selectedBehaviour ? "success" : ""}">${escapeHtml(selectedBadge)}</span>
      </button>
      <div class="accordion-body">
        <div class="carousel-shell">
          <button class="carousel-nav" type="button" data-carousel-prev="${record.keyElementId}" aria-label="Previous behaviour">‹</button>
          <div class="behaviour-wheel"
            data-key-id="${record.keyElementId}"
            data-loop-pad="${loopPad}"
            data-loop-count="${record.behaviours.length}"
            data-behaviour-order="${escapeAttribute(behaviourOrder)}"
            role="group"
            aria-label="Observable behaviours for ${escapeHtml(record.keyElementName)}">
            ${loopItems.map(loopItem => {
              const behaviour = loopItem.behaviour;
              const isPreview  = behaviour.id === activePreviewId;
              const isSelected = behaviour.id === selectedBehaviourId;
              const descText   = behaviourDescriptionText(behaviour.description);
              return `
                <button type="button"
                  class="level-btn behaviour-node ${isPreview ? "preview" : ""} ${isSelected ? "selected" : ""} ${loopItem.isClone ? "is-clone" : ""}"
                  data-key-id="${record.keyElementId}"
                  data-behaviour-id="${behaviour.id}"
                  data-real-index="${loopItem.realIndex}"
                  data-loop-clone="${loopItem.isClone ? "true" : "false"}"
                  aria-label="Select behaviour ${escapeHtml(behaviour.name)}"
                  aria-pressed="${isSelected ? "true" : "false"}"
                  title="${escapeAttribute(behaviour.name)}">
                  <span class="behaviour-node-inner">
                    <span class="behaviour-node-title">${escapeHtml(behaviour.name)}</span>
                    <span class="behaviour-node-text">${escapeHtml(descText)}</span>
                  </span>
                </button>
              `;
            }).join("")}
          </div>
          <button class="carousel-nav" type="button" data-carousel-next="${record.keyElementId}" aria-label="Next behaviour">›</button>
        </div>

        <div class="carousel-dots" aria-label="Carousel pagination">
          ${record.behaviours.map(behaviour => `
            <button type="button"
              class="carousel-dot ${behaviour.id === activePreviewId ? "active" : ""}"
              data-carousel-dot-key="${record.keyElementId}"
              data-behaviour-id="${behaviour.id}"
              aria-label="Go to ${escapeHtml(shortBehaviourLabel(behaviour.name))}">
            </button>
          `).join("")}
        </div>

        ${previewBehaviour ? `
          <div class="preview-card" aria-live="polite">
            <h4 data-preview-name="${record.keyElementId}">${escapeHtml(previewBehaviour.name)}</h4>
            <div class="action-row">
              <span class="meta">Tap the centred card to select this behaviour.</span>
              ${selectedBehaviour ? `<button class="btn ghost" type="button" data-clear-selected="${record.keyElementId}">Clear</button>` : ""}
            </div>
          </div>
        ` : ""}
      </div>
    </article>
  `;
}

function bindBehaviourAccordions() {
  Array.from(el.main.querySelectorAll("[data-beh-accordion] > .accordion-header")).forEach(btn => {
    btn.addEventListener("click", () => {
      const keyId = btn.closest("[data-beh-accordion]")?.dataset.behAccordion;
      if (!keyId) return;
      state.openBehaviourAccordionId = state.openBehaviourAccordionId === keyId ? "" : keyId;
      renderStep2();
    });
  });
  Array.from(el.main.querySelectorAll("[data-clear-selected]")).forEach(btn => {
    btn.addEventListener("click", () => {
      const keyId = btn.dataset.clearSelected;
      delete state.selectedBehaviourByKeyElementId[keyId];
      renderStep2(); renderStepper(); renderStickyActions();
    });
  });
}

/*
  FIX: Clicking a behaviour node now correctly selects it when it is the
  centred card.  The original code checked `btn.classList.contains("is-center")`
  but `is-center` is applied asynchronously by the scroll listener — on a fresh
  render the class hasn't been applied yet.  We instead check whether the node
  is already the active-preview for that key element (i.e. it IS the centred one)
  and allow a short grace window by comparing positions ourselves.
*/
function bindLevelButtons() {
  Array.from(el.main.querySelectorAll("[data-key-id][data-behaviour-id]")).forEach(btn => {
    btn.addEventListener("click", () => {
      const keyId      = btn.dataset.keyId;
      const behaviourId = btn.dataset.behaviourId;

      // Update preview
      state.activePreviewByKeyElementId[keyId] = behaviourId;

      // Determine if this node is (or should become) the centred one.
      // We check both the `is-center` class and whether the node is already
      // the active preview (meaning it was centred from a dot/arrow click).
      const isCentred = btn.classList.contains("is-center") ||
                        (!btn.classList.contains("is-near") && !btn.classList.contains("is-far") &&
                         !btn.classList.contains("is-clone"));

      if (isCentred) {
        state.selectedBehaviourByKeyElementId[keyId] = behaviourId;
        state.validationMessage = "";
        renderStep2(); renderStepper(); renderStickyActions();
        return;
      }

      // Not centred — scroll it into view so user can tap again
      btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });

    btn.addEventListener("dblclick", () => {
      const keyId = btn.dataset.keyId;
      const behaviourId = btn.dataset.behaviourId;
      state.selectedBehaviourByKeyElementId[keyId] = behaviourId;
      renderStep2(); renderStepper(); renderStickyActions();
    });
  });
}

function buildLoopBehaviours(behaviours, pad) {
  if (!Array.isArray(behaviours) || !behaviours.length) return [];
  if (behaviours.length === 1 || pad <= 0) {
    return behaviours.map((b, i) => ({ behaviour: b, isClone: false, realIndex: i }));
  }
  const p = Math.min(pad, behaviours.length);
  const leading  = behaviours.slice(-p).map((b, i) => ({ behaviour: b, isClone: true,  realIndex: behaviours.length - p + i }));
  const center   = behaviours.map((b, i)            => ({ behaviour: b, isClone: false, realIndex: i }));
  const trailing = behaviours.slice(0, p).map((b, i) => ({ behaviour: b, isClone: true,  realIndex: i }));
  return [...leading, ...center, ...trailing];
}

function bindBehaviourCarouselControls() {
  Array.from(el.main.querySelectorAll("[data-carousel-prev]")).forEach(btn => {
    btn.addEventListener("click", () => moveCarousel(btn.dataset.carouselPrev, -1));
  });
  Array.from(el.main.querySelectorAll("[data-carousel-next]")).forEach(btn => {
    btn.addEventListener("click", () => moveCarousel(btn.dataset.carouselNext, 1));
  });
  Array.from(el.main.querySelectorAll("[data-carousel-dot-key][data-behaviour-id]")).forEach(dot => {
    dot.addEventListener("click", () => {
      const keyId       = dot.dataset.carouselDotKey;
      const behaviourId = dot.dataset.behaviourId;
      if (!keyId || !behaviourId) return;
      const wheel = el.main.querySelector(`.behaviour-wheel[data-key-id="${CSS.escape(keyId)}"]`);
      state.activePreviewByKeyElementId[keyId] = behaviourId;
      scrollToBehaviourNode(wheel, behaviourId, { behavior: "smooth" });
      // After scroll settles, mark as selected (dot click = intent to select)
      setTimeout(() => {
        state.selectedBehaviourByKeyElementId[keyId] = behaviourId;
        renderStep2(); renderStepper(); renderStickyActions();
      }, 320);
    });
  });
}

function moveCarousel(keyId, delta) {
  if (!keyId) return;
  const wheel = el.main.querySelector(`.behaviour-wheel[data-key-id="${CSS.escape(keyId)}"]`);
  if (!wheel) return;
  const orderedIds = (wheel.dataset.behaviourOrder || "").split("|").filter(Boolean);
  if (!orderedIds.length) return;
  const activeId    = state.activePreviewByKeyElementId[keyId] || orderedIds[0];
  const currentIdx  = Math.max(0, orderedIds.indexOf(activeId));
  const nextIdx     = (currentIdx + delta + orderedIds.length) % orderedIds.length;
  const nextId      = orderedIds[nextIdx];
  state.activePreviewByKeyElementId[keyId] = nextId;
  scrollToBehaviourNode(wheel, nextId, { behavior: "smooth" });
}

function bindBehaviourCarouselFocus() {
  Array.from(el.main.querySelectorAll(".behaviour-wheel")).forEach(wheel => {
    const nodes = Array.from(wheel.querySelectorAll(".behaviour-node"));
    if (!nodes.length) return;
    const keyId = wheel.dataset.keyId || "";

    const initialId = state.activePreviewByKeyElementId[keyId] || nodes[0]?.dataset.behaviourId;
    scrollToBehaviourNode(wheel, initialId, { behavior: "auto", preferReal: true });

    let adjustingLoop = false;

    const updateCenter = () => {
      if (adjustingLoop) return;
      const track   = wheel.getBoundingClientRect();
      const centerX = track.left + track.width / 2;
      let closest = nodes[0], closestIdx = 0, closestDist = Infinity;

      nodes.forEach((node, idx) => {
        const rect = node.getBoundingClientRect();
        const dist = Math.abs(rect.left + rect.width / 2 - centerX);
        node.classList.remove("is-center", "is-near", "is-far");
        if (dist < closestDist) { closestDist = dist; closest = node; closestIdx = idx; }
      });

      if (closest) {
        closest.classList.add("is-center");
        nodes.forEach((node, idx) => {
          if (idx === closestIdx) return;
          node.classList.add(Math.abs(idx - closestIdx) === 1 ? "is-near" : "is-far");
        });

        if (keyId && closest.dataset.behaviourId) {
          const centeredId = closest.dataset.behaviourId;
          state.activePreviewByKeyElementId[keyId] = centeredId;

          // Update dots
          Array.from(el.main.querySelectorAll(`[data-carousel-dot-key="${CSS.escape(keyId)}"]`)).forEach(dot => {
            dot.classList.toggle("active", dot.dataset.behaviourId === centeredId);
          });

          // Update preview name
          const previewName = el.main.querySelector(`[data-preview-name="${CSS.escape(keyId)}"]`);
          const rec = state.normalizedKeyElements.find(r => r.keyElementId === keyId);
          const beh = rec?.behaviours?.find(b => b.id === centeredId);
          if (previewName && beh) previewName.textContent = beh.name;
        }

        // Loop teleport
        if (closest.dataset.loopClone === "true") {
          const realIndex = closest.dataset.realIndex;
          const realNode  = nodes.find(n => n.dataset.loopClone !== "true" && n.dataset.realIndex === realIndex);
          if (realNode) {
            adjustingLoop = true;
            realNode.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
            window.requestAnimationFrame(() => { adjustingLoop = false; updateCenter(); });
          }
        }
      }
    };

    updateCenter();
    wheel.addEventListener("scroll", () => window.requestAnimationFrame(updateCenter), { passive: true });
  });
}

function scrollToBehaviourNode(wheel, behaviourId, options = {}) {
  if (!wheel || !behaviourId) return null;
  const candidates = Array.from(wheel.querySelectorAll(`.behaviour-node[data-behaviour-id="${CSS.escape(behaviourId)}"]`));
  if (!candidates.length) return null;
  const preferred = options.preferReal ? candidates.filter(n => n.dataset.loopClone !== "true") : candidates;
  const pool   = preferred.length ? preferred : candidates;
  const track  = wheel.getBoundingClientRect();
  const centerX = track.left + track.width / 2;
  let target = pool[0], minDist = Infinity;
  pool.forEach(n => {
    const r = n.getBoundingClientRect();
    const d = Math.abs(r.left + r.width / 2 - centerX);
    if (d < minDist) { minDist = d; target = n; }
  });
  target.scrollIntoView({ behavior: options.behavior || "smooth", block: "nearest", inline: "center" });
  return target;
}

function ensurePreviewSelections(records) {
  records.forEach(record => {
    const selected = state.selectedBehaviourByKeyElementId[record.keyElementId];
    if (selected && record.behaviours.some(b => b.id === selected)) {
      state.activePreviewByKeyElementId[record.keyElementId] = selected;
      return;
    }
    const cur = state.activePreviewByKeyElementId[record.keyElementId];
    if (!cur || !record.behaviours.some(b => b.id === cur)) {
      state.activePreviewByKeyElementId[record.keyElementId] = record.behaviours[0]?.id;
    }
  });
}

/* ── Step 3 ──────────────────────────────────────────────────────── */

function renderStep3() {
  const autoSummaryPreview    = buildAutoSummary();
  const domainSummaryPreview  = buildDomainSummaryText();
  const observedPreview       = buildObservedText();
  const nextPreview           = buildNextStepText();
  const practiceSupportPreview = buildPracticeSupportLink();

  // Auto-populate form fields on first arrival to Step 3
  // (only if not already populated, to preserve user edits)
  if (!state.summaryForm.domainSummary && domainSummaryPreview) {
    state.summaryForm.domainSummary = domainSummaryPreview;
  }
  if (!state.summaryForm.observedText && observedPreview) {
    state.summaryForm.observedText = observedPreview;
  }
  if (!state.summaryForm.nextStepText && nextPreview) {
    state.summaryForm.nextStepText = nextPreview;
  }
  if (!state.summaryForm.autoSummary && autoSummaryPreview) {
    state.summaryForm.autoSummary = autoSummaryPreview;
  }

  // Build educator datalist
  const educatorOptions = state.educatorNames.map(n =>
    `<option value="${escapeAttribute(n)}">${escapeHtml(n)}</option>`).join("");

  el.main.innerHTML = `
    <section class="panel" aria-labelledby="step3Title">
      <h2 class="section-title" id="step3Title">Fill Learning Progression Summary</h2>
      ${renderLearningBreadcrumbs()}

      <div class="action-row">
        <button class="btn secondary" type="button" id="generateDraftBtn">Generate Statement Draft</button>
      </div>

      <datalist id="educatorList">${educatorOptions}</datalist>

      <div class="field-grid">

        <!-- Section: Session Details -->
        <div class="form-section" style="--section-accent:#e0f0fb;">
          <div class="form-section-header">
            <span class="fs-icon">📋</span>
            <h4>Session Details</h4>
          </div>
          <div class="form-section-body">
            <div class="form-row">
              <div class="field">
                <label>Learner Code</label>
                <div class="field-note">${escapeHtml(getCodeIcon(state.summaryForm.learnerCode || ""))} ${escapeHtml(state.summaryForm.learnerCode || "Not set")}</div>
              </div>
              <div class="field">
                <label for="observationDate">Observation Date</label>
                <input id="observationDate" name="observationDate" type="date"
                  value="${escapeAttribute(state.summaryForm.observationDate || getTodayISO())}" />
              </div>
            </div>
            <div class="form-row">
              <div class="field">
                <label for="childName">Child's Name / Code</label>
                <input id="childName" name="childName"
                  value="${escapeAttribute(state.summaryForm.childName)}"
                  placeholder="e.g. Child A" />
              </div>
              <div class="field">
                <label for="observerName">Observer's Name</label>
                <div class="observer-wrap">
                  <input id="observerName" name="observerName"
                    list="educatorList"
                    value="${escapeAttribute(state.summaryForm.observerName)}"
                    placeholder="Start typing or choose…"
                    autocomplete="off" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Section: Domain Summary -->
        <div class="form-section" style="--section-accent:#e5f5ec;">
          <div class="form-section-header">
            <span class="fs-icon">🌱</span>
            <h4>Learning Domain</h4>
          </div>
          <div class="form-section-body">
            <div class="form-row full">
              <div class="field">
                <label for="domainSummary">Learning domain summary</label>
                <textarea id="domainSummary" name="domainSummary">${escapeHtml(state.summaryForm.domainSummary || domainSummaryPreview)}</textarea>
              </div>
            </div>
          </div>
        </div>

        <!-- Section: Observation Evidence -->
        <div class="form-section" style="--section-accent:#fdf0e0;">
          <div class="form-section-header">
            <span class="fs-icon">🔍</span>
            <h4>Observation &amp; Evidence</h4>
          </div>
          <div class="form-section-body">
            <div class="form-row full">
              <div class="field">
                <label for="contextEvidence">Context or evidence collected</label>
                <textarea id="contextEvidence" name="contextEvidence"
                  placeholder="Describe the setting, activity, or materials observed…">${escapeHtml(state.summaryForm.contextEvidence || "")}</textarea>
              </div>
            </div>
            <div class="form-row full">
              <div class="field">
                <label for="observedText">What you observed</label>
                <textarea id="observedText" name="observedText">${escapeHtml(state.summaryForm.observedText || observedPreview)}</textarea>
              </div>
            </div>
          </div>
        </div>

        <!-- Section: Next Steps & Reflection -->
        <div class="form-section" style="--section-accent:#ede8f8;">
          <div class="form-section-header">
            <span class="fs-icon">🎯</span>
            <h4>Next Steps &amp; Reflection</h4>
          </div>
          <div class="form-section-body">
            <div class="form-row full">
              <div class="field">
                <label for="nextStepText">Likely next step in learning progression</label>
                <textarea id="nextStepText" name="nextStepText">${escapeHtml(state.summaryForm.nextStepText || nextPreview)}</textarea>
              </div>
            </div>
            <div class="form-row full">
              <div class="field">
                <label for="professionalReflection">Professional reflection</label>
                <textarea id="professionalReflection" name="professionalReflection"
                  placeholder="Reflect on the child's engagement, your teaching approach…">${escapeHtml(state.summaryForm.professionalReflection || "")}</textarea>
              </div>
            </div>
          </div>
        </div>

        <!-- Section: Practice Support -->
        <div class="form-section" style="--section-accent:#e0f4f7;">
          <div class="form-section-header">
            <span class="fs-icon">🔗</span>
            <h4>Practice Support</h4>
          </div>
          <div class="form-section-body">
            <div class="form-row full">
              <div class="field">
                <label for="supportLearning">How you can support this learning</label>
                <textarea id="supportLearning" name="supportLearning"
                  placeholder="Strategies, resources, or adjustments to consider…">${escapeHtml(state.summaryForm.supportLearning || "")}</textarea>
              </div>
            </div>
            <div class="form-row">
              <div class="field">
                <label for="practiceSupportLink">Relevant practice support page (observed)</label>
                <input id="practiceSupportLink" name="practiceSupportLink"
                  value="${escapeAttribute(state.summaryForm.practiceSupportLink || practiceSupportPreview)}" />
              </div>
              <div class="field">
                <label for="supportLearningLink">Relevant practice support page (next steps)</label>
                <input id="supportLearningLink" name="supportLearningLink"
                  value="${escapeAttribute(state.summaryForm.supportLearningLink || practiceSupportPreview)}" />
              </div>
            </div>
          </div>
        </div>

        <!-- Section: Learning Progression Statement -->
        <div class="form-section" style="--section-accent:#fce8f0;">
          <div class="form-section-header">
            <span class="fs-icon">📝</span>
            <h4>Learning Progression Statement</h4>
          </div>
          <div class="form-section-body">
            <div class="form-row full">
              <div class="field">
                <label>Format</label>
                <div class="chip-grid">
                  <button type="button" class="chip ${state.summaryForm.summaryStyle === "option1" ? "selected" : ""}" data-summary-style="option1">Option 1 (Grouped)</button>
                  <button type="button" class="chip ${state.summaryForm.summaryStyle === "option2" ? "selected" : ""}" data-summary-style="option2">Option 2 (Per Element)</button>
                </div>
              </div>
            </div>
            <div class="form-row full">
              <div class="field">
                <label for="autoSummary">Generated statement</label>
                <textarea id="autoSummary" name="autoSummary" style="min-height:120px;">${escapeHtml(state.summaryForm.autoSummary || autoSummaryPreview)}</textarea>
              </div>
            </div>
          </div>
        </div>

      </div><!-- end field-grid -->
    </section>
  `;

  bindSummaryForm();
}

function getCodeOptions() {
  return Array.isArray(state.codeOptions) && state.codeOptions.length ? state.codeOptions : CODE_OPTIONS;
}

function bindSummaryForm() {
  const textIds = [
    "childName", "observerName", "observationDate",
    "domainSummary", "contextEvidence", "observedText",
    "nextStepText", "professionalReflection",
    "practiceSupportLink", "supportLearning", "supportLearningLink",
    "autoSummary", "sessionLabel"
  ];

  textIds.forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("input", () => { state.summaryForm[id] = input.value; });
  });

  // Learner code from <select>
  const codeSelect = document.getElementById("learnerCodeSelect");
  if (codeSelect) {
    codeSelect.addEventListener("change", () => {
      state.summaryForm.learnerCode = codeSelect.value;
      renderSessionMeta();
    });
  }

  document.getElementById("generateDraftBtn")?.addEventListener("click", () => {
    state.summaryForm.domainSummary    = buildDomainSummaryText();
    state.summaryForm.observedText     = buildObservedText();
    state.summaryForm.nextStepText     = buildNextStepText();
    state.summaryForm.practiceSupportLink = state.summaryForm.practiceSupportLink || buildPracticeSupportLink();
    state.summaryForm.autoSummary      = buildAutoSummary();
    renderStep3();
  });

  Array.from(el.main.querySelectorAll("[data-summary-style]")).forEach(btn => {
    btn.addEventListener("click", () => {
      state.summaryForm.summaryStyle = btn.dataset.summaryStyle || "option1";
      state.summaryForm.autoSummary  = buildAutoSummary();
      renderStep3();
    });
  });
}

/* ── Auto-summary builders ───────────────────────────────────────── */

function buildAutoSummary() {
  const rows = getSelectedObservationRows();
  if (!rows.length) return "";
  if (state.summaryForm.summaryStyle === "option2") {
    return rows.map(row => {
      const currentDesc = behaviourDescriptionText(row.selectedBehaviour.description);
      const nextBehaviour = row.nextBehaviour || { name: "Continue consolidating current behaviour", description: "" };
      const nextDesc = behaviourDescriptionText(nextBehaviour.description);
      const nextText = `What is the likely next step in learning: ${nextBehaviour.name}${nextDesc ? "\n" + nextDesc : ""}`;
      return `${row.keyElementName}: What this suggests about current learning and development: ${row.selectedBehaviour.name}${currentDesc ? "\n" + currentDesc : ""}\n${nextText}`;
    }).join("\n\n");
  }

  const currentLines = rows.map(r => {
    const selectedDesc = behaviourDescriptionText(r.selectedBehaviour.description);
    return `• ${r.keyElementName}: ${r.selectedBehaviour.name}${selectedDesc ? "\n" + selectedDesc : ""}`;
  });
  const nextLines = rows.map(r => {
    const nextBehaviour = r.nextBehaviour || { name: "Continue consolidating current behaviour", description: "" };
    const nextDesc = behaviourDescriptionText(nextBehaviour.description);
    return `• ${r.keyElementName}: ${nextBehaviour.name}${nextDesc ? "\n" + nextDesc : ""}`;
  });
  return `What this suggests about current learning:\n${currentLines.join("\n\n")}\n\nWhat is likely to be the next step in learning:\n${nextLines.join("\n\n")}`;
}

function getSelectedObservationRows() {
  return getSelectedKeyElementRecords()
    .map(record => {
      const behaviourId = state.selectedBehaviourByKeyElementId[record.keyElementId];
      if (!behaviourId) return null;
      const selectedBehaviour = record.behaviours.find(b => b.id === behaviourId);
      if (!selectedBehaviour) return null;
      return {
        domainName:        record.domainName,
        subdomainName:     record.subdomainName || record.parentElementName || "",
        keyElementName:    record.keyElementName,
        selectedBehaviour,
        nextBehaviour: getNextBehaviour(record.behaviours, behaviourId)
      };
    })
    .filter(Boolean);
}

function getNextBehaviour(behaviours, selectedId) {
  const ordered = sortByIndex(behaviours || []);
  const idx     = ordered.findIndex(b => b.id === selectedId);
  return idx < 0 ? null : (ordered[idx + 1] || null);
}

function buildDomainSummaryText() {
  const selected = getSelectedKeyElementRecords();
  if (!selected.length) return "";
  const d = selected[0];
  return `${d.domainName}: ${d.domainSummary || "Summary unavailable."}`;
}

function buildObservedText() {
  const rows = getSelectedObservationRows();
  return rows.map(r => {
    const descText = behaviourDescriptionText(r.selectedBehaviour.description);
    return `• ${r.keyElementName}: ${r.selectedBehaviour.name}${descText ? "\n" + descText : ""}`;
  }).join("\n\n");
}

function buildNextStepText() {
  const rows = getSelectedObservationRows();
  return rows.map(r => {
    const nextBehaviour = r.nextBehaviour || { name: "Continue consolidating current behaviour", description: "" };
    const descText = behaviourDescriptionText(nextBehaviour.description);
    return `• ${r.keyElementName}: ${nextBehaviour.name}${descText ? "\n" + descText : ""}`;
  }).join("\n\n");
}

function buildPracticeSupportLink() {
  const selected = getSelectedKeyElementRecords();
  if (!selected.length) return "";
  return `/practice-support/${selected[0].domainName.toLowerCase().replace(/\s+/g, "-")}`;
}

/* ── Step 4 ──────────────────────────────────────────────────────── */

function renderStep4() {
  const selectedRecords = getSelectedKeyElementRecords();
  const behaviourItems  = selectedRecords.map(record => {
    const behaviourId = state.selectedBehaviourByKeyElementId[record.keyElementId];
    return { record, behaviour: record.behaviours.find(b => b.id === behaviourId) };
  });

  el.main.innerHTML = `
    <section class="panel" aria-labelledby="step4Title">
      <h2 class="section-title" id="step4Title">Review and Print</h2>
      ${renderLearningBreadcrumbs()}
      <div class="review-grid">
        <article class="review-card">
          <div class="review-head">
            <h3>Learning Areas and Selected Behaviours</h3>
            <button class="btn ghost" type="button" data-jump-step="2">Edit</button>
          </div>
          ${behaviourItems.map(({ record, behaviour }) => {
            const colors = getDomainColors(record.domainId);
            return `
              <div class="card" style="padding:10px; margin-bottom:10px; --accent:${colors.accent}; --accent-deep:${colors.deep}; border-left:4px solid ${colors.accent};">
                <p><strong>${escapeHtml(record.domainName)}</strong>${record.subdomainName ? `  |  ${escapeHtml(record.subdomainName)}` : ""}${record.parentElementName ? `  |  ${escapeHtml(record.parentElementName)}` : ""}</p>
                <p>${escapeHtml(record.keyElementName)}  |  <span class="badge ${behaviour ? "success" : ""}">${escapeHtml(behaviour ? behaviour.name : "Not selected")}</span></p>
              </div>`;
          }).join("") || "<p>No selected learning areas.</p>"}
        </article>

        <article class="review-card">
          <div class="review-head">
            <h3>Summary Form</h3>
            <button class="btn ghost" type="button" data-jump-step="3">Edit</button>
          </div>
          <p><strong>Learner Code:</strong> ${escapeHtml(state.summaryForm.learnerCode || "-")}</p>
          <p><strong>Child Name / Code:</strong> ${escapeHtml(state.summaryForm.childName || "-")}</p>
          <p><strong>Observer Name:</strong> ${escapeHtml(state.summaryForm.observerName || "-")}</p>
          <p><strong>Date:</strong> ${escapeHtml(state.summaryForm.observationDate || "-")}</p>
          ${renderReviewField("Learning Domain Summary", state.summaryForm.domainSummary || buildDomainSummaryText())}
          ${renderReviewField("Context / Evidence", state.summaryForm.contextEvidence)}
          ${renderReviewField("What You Observed", state.summaryForm.observedText || buildObservedText())}
          ${renderReviewField("Likely Next Step", state.summaryForm.nextStepText || buildNextStepText())}
          ${renderReviewField("Professional Reflection", state.summaryForm.professionalReflection)}
          ${renderReviewField("Practice Support Link", state.summaryForm.practiceSupportLink || buildPracticeSupportLink())}
          ${renderReviewField("How You Can Support This Learning", state.summaryForm.supportLearning)}
          ${renderReviewField("Support Learning Link", state.summaryForm.supportLearningLink || buildPracticeSupportLink())}
          <div style="margin-top:10px;">
            <p><strong>Generated Summary</strong></p>
            <p style="white-space:pre-wrap;">${escapeHtml(state.summaryForm.autoSummary || buildAutoSummary() || "-")}</p>
          </div>
          <div style="margin-top:20px; display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
            <button class="btn ghost" type="button" id="savePdfBtn">💾 Save to PDF</button>
            <button class="btn secondary" type="button" id="printBtn">🖨️ Print</button>
          </div>
        </article>
      </div>
    </section>
  `;

  Array.from(el.main.querySelectorAll("[data-jump-step]")).forEach(btn => {
    btn.addEventListener("click", () => tryNavigateToStep(Number(btn.dataset.jumpStep), { force: true }));
  });

  document.getElementById("savePdfBtn")?.addEventListener("click", () => {
    openReviewPrintWindow();
  });

  document.getElementById("printBtn")?.addEventListener("click", () => {
    openReviewPrintWindow();
  });
}

function openReviewPrintWindow() {
  const selectedRecords = getSelectedKeyElementRecords();
  const behaviourItems  = selectedRecords.map(record => {
    const behaviourId = state.selectedBehaviourByKeyElementId[record.keyElementId];
    return { record, behaviour: record.behaviours.find(b => b.id === behaviourId) };
  });
  const printHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Learning Observation - KLPT</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.6; color: #333; }
          h1, h2, h3 { margin-top: 20px; margin-bottom: 10px; }
          .section { margin-bottom: 20px; page-break-inside: avoid; }
          .field { margin-bottom: 12px; }
          .label { font-weight: bold; color: #555; }
          .value { margin-top: 4px; white-space: pre-wrap; }
          .behaviour-item { margin-left: 20px; margin-bottom: 15px; padding-left: 10px; border-left: 3px solid #0077C1; }
          @media print { body { margin: 10px; } .section { page-break-inside: avoid; } }
        </style>
      </head>
      <body>
        <h1>Learning Observation Summary</h1>
        <div class="section">
          <h2>Session Information</h2>
          <div class="field">
            <span class="label">Learner Code:</span>
            <div class="value">${escapeHtml(state.summaryForm.learnerCode || '-')}</div>
          </div>
          <div class="field">
            <span class="label">Child Name:</span>
            <div class="value">${escapeHtml(state.summaryForm.childName || '-')}</div>
          </div>
          <div class="field">
            <span class="label">Observer Name:</span>
            <div class="value">${escapeHtml(state.summaryForm.observerName || '-')}</div>
          </div>
          <div class="field">
            <span class="label">Date:</span>
            <div class="value">${escapeHtml(state.summaryForm.observationDate || '-')}</div>
          </div>
        </div>
        <div class="section">
          <h2>Learning Areas & Behaviours</h2>
          ${behaviourItems.map(({ record, behaviour }) => `
            <div class="behaviour-item">
              <div style="font-weight: bold;">${escapeHtml(record.domainName)}${record.subdomainName ? ` | ${escapeHtml(record.subdomainName)}` : ""}${record.parentElementName ? ` | ${escapeHtml(record.parentElementName)}` : ""}</div>
              <div>${escapeHtml(record.keyElementName)}</div>
              <div style="color: #0077C1; margin-top: 4px;">${escapeHtml(behaviour ? behaviour.name : 'Not selected')}</div>
            </div>
          `).join("")}
        </div>
        <div class="section">
          <h2>Learning Domain Summary</h2>
          <div class="value">${escapeHtml(state.summaryForm.domainSummary || buildDomainSummaryText() || '-')}</div>
        </div>
        <div class="section">
          <h2>Context / Evidence</h2>
          <div class="value">${escapeHtml(state.summaryForm.contextEvidence || '-')}</div>
        </div>
        <div class="section">
          <h2>What You Observed</h2>
          <div class="value">${escapeHtml(state.summaryForm.observedText || buildObservedText() || '-')}</div>
        </div>
        <div class="section">
          <h2>Likely Next Step</h2>
          <div class="value">${escapeHtml(state.summaryForm.nextStepText || buildNextStepText() || '-')}</div>
        </div>
        <div class="section">
          <h2>Professional Reflection</h2>
          <div class="value">${escapeHtml(state.summaryForm.professionalReflection || '-')}</div>
        </div>
        <div class="section">
          <h2>How You Can Support This Learning</h2>
          <div class="value">${escapeHtml(state.summaryForm.supportLearning || '-')}</div>
        </div>
        <div class="section">
          <h2>Generated Learning Progression Statement</h2>
          <div class="value">${escapeHtml(state.summaryForm.autoSummary || buildAutoSummary() || '-')}</div>
        </div>
      </body>
    </html>
  `;
  const printWin = window.open('', '', 'width=800,height=600');
  printWin.document.write(printHtml);
  printWin.document.close();
  printWin.print();
}

function renderReviewField(title, value) {
  return `
    <div style="margin-top:10px;">
      <p><strong>${escapeHtml(title)}</strong></p>
      <p style="white-space:pre-wrap;">${escapeHtml(value || "-")}</p>
    </div>`;
}

/* ── Step 5 ──────────────────────────────────────────────────────── */

function renderStep5() {
  const groups = groupDraftsByObserver(state.savedDrafts);

  const deleteAllSessionsButton = state.savedDrafts.length
    ? `<button type="button" class="btn ghost small delete-all-sessions-btn">Delete all</button>`
    : "";
  let recentHtml;
  if (!state.savedDrafts.length) {
    recentHtml = '<p class="meta">No local drafts yet.</p>';
  } else {
    recentHtml = "";
    for (const [observer, groupDrafts] of groups) {
      recentHtml += `<div class="recent-group"><div class="recent-group-label">${escapeHtml(observer)}</div>`;
      groupDrafts.forEach(draft => {
        const idx = state.savedDrafts.indexOf(draft);
        recentHtml += `
          <div class="recent-item session-card" data-load-draft="${idx}">
            <div class="session-card-content">
              <div class="session-card-title-row">
                <p><strong>${escapeHtml(getCodeIcon(draft.summaryForm?.learnerCode || ""))} ${escapeHtml(draft.summaryForm?.learnerCode || draft.summaryForm?.sessionLabel || draft.sessionId)}</strong></p>
                <small>${escapeHtml(formatDateTime(draft.timestamp))}</small>
              </div>
            </div>
            <button class="icon-delete" type="button" data-delete-draft="${idx}"
              title="Delete session"
              aria-label="Delete ${escapeHtml(draft.summaryForm?.learnerCode || draft.sessionId)}"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>`;
      });
      recentHtml += `</div>`;
    }
  }

  el.main.innerHTML = `
    <section class="panel" aria-labelledby="step5Title">
      <h2 class="section-title" id="step5Title">Save / Print</h2>
      ${renderLearningBreadcrumbs()}

      <div class="action-row">
        <button class="btn primary"   type="button" id="saveDraftBtn">Save Draft</button>
        <button class="btn secondary" type="button" id="startNewBtn">Start New Observation</button>
        <button class="btn warn"      type="button" id="clearSessionBtn">Clear Session</button>
        <button class="btn ghost"     type="button" id="printBtn">Print / Export PDF</button>
        <button class="btn ghost"     type="button" id="exportJsonBtn">Export JSON</button>
      </div>

      <article class="review-card" style="margin-top:12px;">
        <div class="session-panel-header">
          <h3>Saved sessions (${state.savedDrafts.length})</h3>
          ${deleteAllSessionsButton}
        </div>
        <div class="recent-list">${recentHtml}</div>
      </article>
    </section>
  `;

  document.getElementById("saveDraftBtn")?.addEventListener("click", () => { saveCurrentDraft(); renderStep5(); });
  document.getElementById("startNewBtn")?.addEventListener("click", () => {
    showCodeSelectionModal();
  });
  document.getElementById("clearSessionBtn")?.addEventListener("click", async () => {
    const confirmed = await showConfirm("Clear Session", "Clear current session data and remove saved drafts from this browser?");
    if (!confirmed) return;
    resetCurrentSession(); state.savedDrafts = []; persistDrafts();
    state.currentStep = 1; render(); focusMain();
  });
  Array.from(el.main.querySelectorAll(".delete-all-sessions-btn")).forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!state.savedDrafts.length) return;
      const confirmed = await showConfirm(
        "Delete all saved sessions",
        "Delete all saved sessions? This cannot be undone."
      );
      if (!confirmed) return;
      state.savedDrafts = [];
      persistDrafts();
      renderStep5();
    });
  });
  Array.from(el.main.querySelectorAll("[data-delete-draft]")).forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.deleteDraft);
      state.savedDrafts.splice(idx, 1);
      persistDrafts();
      renderStep5();
    });
  });
  document.getElementById("printBtn")?.addEventListener("click", () => {
    // Print the review form data
    const selectedRecords = getSelectedKeyElementRecords();
    const behaviourItems  = selectedRecords.map(record => {
      const behaviourId = state.selectedBehaviourByKeyElementId[record.keyElementId];
      return { record, behaviour: record.behaviours.find(b => b.id === behaviourId) };
    });
    
    const printHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Learning Observation - KLPT</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.6; color: #333; }
            h1, h2, h3 { margin-top: 20px; margin-bottom: 10px; }
            .section { margin-bottom: 20px; page-break-inside: avoid; }
            .field { margin-bottom: 12px; }
            .label { font-weight: bold; color: #555; }
            .value { margin-top: 4px; white-space: pre-wrap; }
            .behaviour-item { margin-left: 20px; margin-bottom: 15px; padding-left: 10px; border-left: 3px solid #0077C1; }
            @media print { body { margin: 10px; } .section { page-break-inside: avoid; } }
          </style>
        </head>
        <body>
          <h1>Learning Observation Summary</h1>
          
          <div class="section">
            <h2>Session Information</h2>
            <div class="field">
              <span class="label">Learner Code:</span>
              <div class="value">${escapeHtml(state.summaryForm.learnerCode || '-')}</div>
            </div>
            <div class="field">
              <span class="label">Child Name:</span>
              <div class="value">${escapeHtml(state.summaryForm.childName || '-')}</div>
            </div>
            <div class="field">
              <span class="label">Observer Name:</span>
              <div class="value">${escapeHtml(state.summaryForm.observerName || '-')}</div>
            </div>
            <div class="field">
              <span class="label">Date:</span>
              <div class="value">${escapeHtml(state.summaryForm.observationDate || '-')}</div>
            </div>
          </div>
          
          <div class="section">
            <h2>Learning Areas & Behaviours</h2>
            ${behaviourItems.map(({ record, behaviour }) => `
              <div class="behaviour-item">
                <div style="font-weight: bold;">${escapeHtml(record.domainName)}${record.subdomainName ? ` | ${escapeHtml(record.subdomainName)}` : ""}${record.parentElementName ? ` | ${escapeHtml(record.parentElementName)}` : ""}</div>
                <div>${escapeHtml(record.keyElementName)}</div>
                <div style="color: #0077C1; margin-top: 4px;">${escapeHtml(behaviour ? behaviour.name : 'Not selected')}</div>
              </div>
            `).join("")}
          </div>
          
          <div class="section">
            <h2>Learning Domain Summary</h2>
            <div class="value">${escapeHtml(state.summaryForm.domainSummary || buildDomainSummaryText() || '-')}</div>
          </div>
          
          <div class="section">
            <h2>Context / Evidence</h2>
            <div class="value">${escapeHtml(state.summaryForm.contextEvidence || '-')}</div>
          </div>
          
          <div class="section">
            <h2>What You Observed</h2>
            <div class="value">${escapeHtml(state.summaryForm.observedText || buildObservedText() || '-')}</div>
          </div>
          
          <div class="section">
            <h2>Likely Next Step</h2>
            <div class="value">${escapeHtml(state.summaryForm.nextStepText || buildNextStepText() || '-')}</div>
          </div>
          
          <div class="section">
            <h2>Professional Reflection</h2>
            <div class="value">${escapeHtml(state.summaryForm.professionalReflection || '-')}</div>
          </div>
          
          <div class="section">
            <h2>How You Can Support This Learning</h2>
            <div class="value">${escapeHtml(state.summaryForm.supportLearning || '-')}</div>
          </div>
          
          <div class="section">
            <h2>Generated Learning Progression Statement</h2>
            <div class="value">${escapeHtml(state.summaryForm.autoSummary || buildAutoSummary() || '-')}</div>
          </div>
        </body>
      </html>
    `;
    const printWin = window.open('', '', 'width=800,height=600');
    printWin.document.write(printHtml);
    printWin.document.close();
    printWin.print();
  });
  document.getElementById("exportJsonBtn")?.addEventListener("click", () => {
    const payload = createDraftPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `klpt-observation-${payload.sessionId}.json`; a.click();
    URL.revokeObjectURL(url);
  });

  // LOAD (click anywhere on card)
Array.from(el.main.querySelectorAll("[data-load-draft]")).forEach(card => {
  card.addEventListener("click", (e) => {
    // ❗ If delete button was clicked, ignore load
    if (e.target.closest("[data-delete-draft]")) return;

    const draft = state.savedDrafts[Number(card.dataset.loadDraft)];
    if (!draft) return;

    hydrateFromDraft(draft);
    state.currentStep = 4;
    render();
    focusMain();
  });
});

// DELETE (❌ only)
Array.from(el.main.querySelectorAll("[data-delete-draft]")).forEach(btn => {
  btn.addEventListener("click", async (e) => {
    e.stopPropagation(); // ✅ prevents triggering card click

    const idx   = Number(btn.dataset.deleteDraft);
    const label = state.savedDrafts[idx]?.summaryForm?.learnerCode || "this session";

    const confirmed = await showConfirm(
      "Delete Session",
      `Delete saved session "${label}"?`
    );

    if (!confirmed) return;

    state.savedDrafts = state.savedDrafts.filter((_, i) => i !== idx);
    persistDrafts();
    renderStep5();
  });
});

  /*Array.from(el.main.querySelectorAll("[data-load-draft]")).forEach(btn => {
    btn.addEventListener("click", () => {
      const draft = state.savedDrafts[Number(btn.dataset.loadDraft)];
      if (!draft) return;
      hydrateFromDraft(draft); state.currentStep = 4; render(); focusMain();
    });
  });

  Array.from(el.main.querySelectorAll("[data-delete-draft]")).forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx   = Number(btn.dataset.deleteDraft);
      const label = state.savedDrafts[idx]?.summaryForm?.learnerCode || "this session";
      const confirmed = await showConfirm("Delete Session", `Delete saved session "${label}"?`);
      if (!confirmed) return;
      state.savedDrafts = state.savedDrafts.filter((_, i) => i !== idx);
      persistDrafts(); renderStep5();
    });
  });*/
}

/* ── Draft / Session Helpers ─────────────────────────────────────── */

function createDraftPayload() {
  const selectedRecords  = getSelectedKeyElementRecords();
  const selectedDomainIds = Array.from(new Set(selectedRecords.map(r => r.domainId)));
  const selectedGroupIds  = Array.from(new Set(selectedRecords.map(r => r.subdomainId || r.parentElementId).filter(Boolean)));
  return {
    sessionId:    state.sessionId,
    timestamp:    new Date().toISOString(),
    observationStartedAt: state.observationStartedAt,
    selectedDomainId:    state.selectedDomainId,
    selectedGroupKey:    state.selectedGroupKey,
    selectedDomainIds,
    selectedGroupIds,
    selectedKeyElementIds:              [...state.selectedKeyElementIds],
    selectedBehaviourByKeyElementId:    { ...state.selectedBehaviourByKeyElementId },
    selectedBehaviourLabelByKeyElementId: deriveSelectedBehaviours(),
    summaryForm: { ...state.summaryForm }
  };
}

function deriveSelectedBehaviours() {
  return getSelectedKeyElementRecords().reduce((acc, record) => {
    const behaviourId = state.selectedBehaviourByKeyElementId[record.keyElementId];
    if (!behaviourId) return acc;
    const b = record.behaviours.find(b => b.id === behaviourId);
    acc[record.keyElementId] = b?.name || behaviourId;
    return acc;
  }, {});
}

function hydrateFromDraft(draft) {
  const draftIndex = state.savedDrafts.indexOf(draft);
  state.loadedSessionIndex = draftIndex >= 0 ? draftIndex : null;
  state.sessionId             = draft.sessionId || createSessionId();
  state.observationStartedAt  = draft.observationStartedAt || draft.timestamp || new Date().toISOString();
  state.selectedDomainId      = draft.selectedDomainId || "";
  state.selectedGroupKey      = draft.selectedGroupKey  || "";
  state.selectedKeyElementIds = (draft.selectedKeyElementIds || [])
    .filter(id => state.normalizedKeyElements.some(item => item.keyElementId === id));
  state.selectedBehaviourByKeyElementId = draft.selectedBehaviourByKeyElementId || {};
  state.activePreviewByKeyElementId     = { ...state.selectedBehaviourByKeyElementId };
  state.summaryForm = {
    ...state.summaryForm,
    ...draft.summaryForm,
    observationDate: draft.summaryForm?.observationDate || getTodayISO()
  };
  reconcileDependentSelections();
}

function resetCurrentSession() {
  state.sessionId             = createSessionId();
  state.loadedSessionIndex    = null;
  state.observationStartedAt  = "";
  state.currentStep           = 1;
  state.selectedDomainId      = "";
  state.selectedKeyElementIds = [];
  state.selectedGroupKey      = "";
  state.activePreviewByKeyElementId     = {};
  state.selectedBehaviourByKeyElementId = {};
  state.validationMessage = "";
  state.summaryForm = {
    learnerCode: "", sessionLabel: "", observationDate: getTodayISO(),
    childName: "", observerName: "", domainSummary: "", contextEvidence: "",
    observedText: "", nextStepText: "", professionalReflection: "",
    practiceSupportLink: "", supportLearning: "", supportLearningLink: "",
    summaryStyle: "option1", autoSummary: "", keyObservations: "",
    strengthsObserved: "", supportAreas: "", educatorNotes: "",
    teachingResponse: "", confidence: ""
  };
}

function startNewObservation(code) {
  if (!code) {
    showAlert("Learner Code Required", "Please choose a learner code before starting a new observation.");
    return;
  }
  resetCurrentSession();
  state.loadedSessionIndex    = null;
  state.observationStartedAt  = new Date().toISOString();
  state.summaryForm.learnerCode = code;
  state.usedCodes.add(code);
}

function showCodeSelectionModal() {
  const availableCodes = getCodeOptions().filter(code => !state.usedCodes.has(code));
  const modal = document.getElementById("codeSelectionModal");
  const grid = document.getElementById("codeSelectionGrid");
  
  if (availableCodes.length === 0) {
    showAlert("No Codes Available", "All learner codes have been used. Please save/print your work or clear the session.");
    return;
  }
  
  grid.innerHTML = availableCodes.map(code => `
    <button type="button" class="code-tile" data-code="${escapeAttribute(code)}">
      <div class="code-icon">${getCodeIcon(code)}</div>
      <div class="code-label">${escapeHtml(code)}</div>
    </button>
  `).join("");
  
  modal.classList.remove("hidden");
  
  // Handle code selection
  Array.from(grid.querySelectorAll(".code-tile")).forEach(btn => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.code;
      modal.classList.add("hidden");
      startNewObservation(code);
      state.view = "flow";
      state.currentStep = 1;
      render();
      focusMain();
    });
  });
  
  // Handle cancel
  document.getElementById("codeModalCancelBtn")?.removeEventListener("click", closeCodeModal);
  document.getElementById("codeModalCancelBtn")?.addEventListener("click", closeCodeModal);
  
  // Handle modal overlay click
  modal.querySelector(".modal-overlay")?.removeEventListener("click", closeCodeModal);
  modal.querySelector(".modal-overlay")?.addEventListener("click", closeCodeModal);
}

function closeCodeModal() {
  const modal = document.getElementById("codeSelectionModal");
  modal.classList.add("hidden");
}

/*
  FIX: saveCurrentDraft now reads the learnerCode from the actual select element
  if Step 3 is currently rendered, so the code is always captured correctly before
  saving — it no longer falls back to "Red Watermelon" when a different code was
  chosen via the select in Step 3 but the `input` event had not fired.
*/
function saveCurrentDraft() {
  // Sync learnerCode from DOM select if present (Step 3 race-condition fix)
  const sel = document.getElementById("learnerCodeSelect");
  if (sel && sel.value) {
    state.summaryForm.learnerCode = sel.value;
  }
  if (!state.summaryForm.learnerCode) {
    showAlert("Missing Learner Code", "Please select a learner code before saving the draft.");
    return;
  }
  state.usedCodes.add(state.summaryForm.learnerCode);
  const payload = createDraftPayload();
  
  // If we're editing an existing session, update it; otherwise create new
  if (state.loadedSessionIndex !== null && state.loadedSessionIndex >= 0 && state.loadedSessionIndex < state.savedDrafts.length) {
    state.savedDrafts[state.loadedSessionIndex] = payload;
  } else {
    // Create new session (prepend and limit to 20)
    state.savedDrafts = [payload, ...state.savedDrafts].slice(0, 20);
  }
  persistDrafts();
  renderSessionMeta(); // refresh meta bar
}

function loadSavedDrafts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function persistDrafts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.savedDrafts));
}

function startAutoSaveTimer() {
  stopAutoSaveTimer();
  state.autoSaveTimer = setInterval(() => {
    if (state.view === "flow") saveCurrentDraft();
  }, 10000);
}

function stopAutoSaveTimer() {
  if (state.autoSaveTimer) { clearInterval(state.autoSaveTimer); state.autoSaveTimer = null; }
}

/* ── Selection / Validation Helpers ─────────────────────────────── */

function reconcileDependentSelections() {
  const selectedRecords = getSelectedKeyElementRecords();
  if (!state.selectedDomainId && selectedRecords.length) {
    state.selectedDomainId = selectedRecords[0].domainId;
  }
  if (!state.selectedGroupKey && selectedRecords.length) {
    state.selectedGroupKey = getScopeFromRecord(selectedRecords[0]).groupKey;
  }
  if (state.selectedDomainId || state.selectedGroupKey) {
    state.selectedKeyElementIds = selectedRecords
      .filter(r => {
        const s = getScopeFromRecord(r);
        return (!state.selectedDomainId || s.domainId === state.selectedDomainId) &&
               (!state.selectedGroupKey  || s.groupKey  === state.selectedGroupKey);
      })
      .map(r => r.keyElementId);
  }
  const selectedSet = new Set(state.selectedKeyElementIds);
  Object.keys(state.selectedBehaviourByKeyElementId).forEach(keyId => {
    if (!selectedSet.has(keyId)) {
      delete state.selectedBehaviourByKeyElementId[keyId];
      delete state.activePreviewByKeyElementId[keyId];
      return;
    }
    const record = state.normalizedKeyElements.find(item => item.keyElementId === keyId);
    if (!record) {
      delete state.selectedBehaviourByKeyElementId[keyId];
      delete state.activePreviewByKeyElementId[keyId];
      return;
    }
    if (state.selectedBehaviourByKeyElementId[keyId] &&
        !record.behaviours.some(b => b.id === state.selectedBehaviourByKeyElementId[keyId])) {
      delete state.selectedBehaviourByKeyElementId[keyId];
    }
    const preview = state.activePreviewByKeyElementId[keyId];
    if (!preview || !record.behaviours.some(b => b.id === preview)) {
      state.activePreviewByKeyElementId[keyId] = record.behaviours[0]?.id;
    }
  });
}

function tryNavigateToStep(targetStep, options = {}) {
  const force = options.force || false;
  if (!force) {
    const validation = validateForStep(targetStep);
    if (!validation.ok) {
      state.validationMessage = validation.message;
      renderMain(); return;
    }
  }
  state.validationMessage = "";
  state.currentStep = targetStep;

  if (state.currentStep === 2) {
    const records = getSelectedKeyElementRecords();
    if (records.length && !state.openBehaviourAccordionId) {
      state.openBehaviourAccordionId = records[0].keyElementId;
    }
  }
  if (state.currentStep === 3 && !state.summaryForm.autoSummary) {
    state.summaryForm.domainSummary  = state.summaryForm.domainSummary  || buildDomainSummaryText();
    state.summaryForm.observedText   = state.summaryForm.observedText   || buildObservedText();
    state.summaryForm.nextStepText   = state.summaryForm.nextStepText   || buildNextStepText();
    state.summaryForm.practiceSupportLink = state.summaryForm.practiceSupportLink || buildPracticeSupportLink();
    state.summaryForm.autoSummary    = buildAutoSummary();
  }
  render(); focusMain();
}

function validateForStep(targetStep) {
  if (targetStep <= state.currentStep) return { ok: true };
  if (targetStep >= 2 && state.selectedKeyElementIds.length < 1) {
    return { ok: false, message: "Please select at least one Key Element before continuing." };
  }
  if (targetStep >= 2) {
    const scope = getCurrentSelectionScope();
    const outOfScope = getSelectedKeyElementRecords().some(r => {
      const s = getScopeFromRecord(r);
      return !scope || s.domainId !== scope.domainId || s.groupKey !== scope.groupKey;
    });
    if (outOfScope) return { ok: false, message: "Please keep selections within one domain and one sub-domain." };
  }
  if (targetStep >= 3) {
    const count = Object.keys(state.selectedBehaviourByKeyElementId)
      .filter(k => state.selectedKeyElementIds.includes(k)).length;
    if (count !== state.selectedKeyElementIds.length) {
      return { ok: false, message: "Please choose one observable behaviour for each selected key element before Step 3." };
    }
  }
  return { ok: true };
}

function getMaxUnlockedStep() {
  let max = 1;
  if (state.selectedKeyElementIds.length > 0) max = 2;
  const count = Object.keys(state.selectedBehaviourByKeyElementId)
    .filter(k => state.selectedKeyElementIds.includes(k)).length;
  if (count === state.selectedKeyElementIds.length && state.selectedKeyElementIds.length > 0) max = STEP_LABELS.length;
  return max;
}

function isStepComplete(step) {
  if (step === 1) return state.selectedKeyElementIds.length > 0;
  if (step === 2) {
    return Object.keys(state.selectedBehaviourByKeyElementId)
      .filter(k => state.selectedKeyElementIds.includes(k)).length === state.selectedKeyElementIds.length
      && state.selectedKeyElementIds.length > 0;
  }
  if (step === 3) return !!(state.summaryForm.autoSummary || buildAutoSummary());
  if (step === 4) return true;
  return false;
}

function getSelectedKeyElementRecords() {
  const s = new Set(state.selectedKeyElementIds);
  return state.normalizedKeyElements.filter(r => s.has(r.keyElementId));
}

function getScopeFromRecord(record) {
  const groupKey = record.subdomainId    ? `sub:${record.subdomainId}`
                 : record.parentElementId ? `parent:${record.parentElementId}`
                 : `direct:${record.domainId}`;
  return {
    domainId: record.domainId,
    domainName: record.domainName,
    groupKey,
    groupName: record.subdomainName || record.parentElementName || "Key Elements"
  };
}

function getCurrentSelectionScope() {
  if (state.selectedDomainId) {
    const allForDomain = state.normalizedKeyElements.filter(i => i.domainId === state.selectedDomainId);
    if (allForDomain.length) {
      const uniqueGroups = Array.from(new Map(allForDomain.map(i => {
        const s = getScopeFromRecord(i);
        return [s.groupKey, s];
      })).values());
      const impliedGroup    = !state.selectedGroupKey && uniqueGroups.length === 1 ? uniqueGroups[0] : null;
      const resolvedGroupKey = state.selectedGroupKey || impliedGroup?.groupKey || "";
      const groupRecord     = resolvedGroupKey
        ? allForDomain.find(i => getScopeFromRecord(i).groupKey === resolvedGroupKey)
        : null;
      return {
        domainId:  state.selectedDomainId,
        domainName: allForDomain[0].domainName,
        groupKey:  resolvedGroupKey,
        groupName: resolvedGroupKey ? (groupRecord?.subdomainName || groupRecord?.parentElementName || "Key Elements") : ""
      };
    }
  }
  const selected = getSelectedKeyElementRecords();
  return selected.length ? getScopeFromRecord(selected[0]) : null;
}

function renderLearningBreadcrumbs() {
  const selected = getSelectedKeyElementRecords();
  const scope    = getCurrentSelectionScope();
  if (!scope?.domainName) return "";
  const keyList = selected.length ? selected.map(i => i.keyElementName).join(", ") : "Select key element(s)";
  const subName = scope.groupName || "Select sub-domain";
  return `
    <nav class="crumbs" aria-label="Selected learning areas">
      <span>${escapeHtml(scope.domainName)}</span>
      <span class="sep">></span>
      <span>${escapeHtml(subName)}</span>
      <span class="sep">></span>
      <span>${escapeHtml(keyList)}</span>
    </nav>`;
}

/* ── Utilities ───────────────────────────────────────────────────── */

function sortByIndex(items) {
  return [...items].sort((a, b) => {
    const ai = typeof a?.index === "number" ? a.index : 9999;
    const bi = typeof b?.index === "number" ? b.index : 9999;
    if (ai !== bi) return ai - bi;
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
}

function shortBehaviourLabel(name) {
  const t = String(name || "").trim();
  return t.length <= 16 ? t : `${t.slice(0, 16)}…`;
}

function behaviourDescriptionText(html) {
  if (!html) return "No observable behaviour details provided.";
  const parser = new DOMParser();
  const doc  = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "No observable behaviour details provided.";
  const lines = [];
  const listItems = Array.from(root.querySelectorAll("li"));
  if (listItems.length) {
    listItems.forEach(li => {
      const t = String(li.textContent || "").replace(/\s+/g, " ").trim();
      if (t) lines.push(`• ${t}`);
    });
    return lines.join("\n");
  }
  const t = String(root.textContent || "").replace(/\s+/g, " ").trim();
  if (t) lines.push(t);
  return lines.join(" ");
}

function simpleHash(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
}

function escapeAttribute(str) {
  return escapeHtml(str).replace(/`/g, "&#96;");
}

function createSessionId() {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getTodayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "Unknown time" : d.toLocaleString();
}

function getCodeIcon(code) {
  const l = String(code || "").toLowerCase();
  if (l.includes("watermelon")) return "🍉";
  if (l.includes("whale"))      return "🐋";
  if (l.includes("turtle"))     return "🐢";
  if (l.includes("lion"))       return "🦁";
  if (l.includes("flamingo"))   return "🦩";
  if (l.includes("dolphin"))    return "🐬";
  if (l.includes("panda"))      return "🐼";
  if (l.includes("fox"))        return "🦊";
  if (l.includes("koala"))      return "🐨";
  if (l.includes("sparrow"))    return "🐦";
  if (l.includes("tiger"))      return "🐯";
  if (l.includes("seahorse"))   return "🐠";
  if (l.includes("owl"))        return "🦉";
  if (l.includes("gecko"))      return "🦎";
  if (l.includes("rabbit"))     return "🐰";
  if (l.includes("penguin"))    return "🐧";
  return "🧩";
}

function focusMain() { el.main.focus(); }


