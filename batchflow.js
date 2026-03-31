/* BatchFlow — Brewing workflow board served from KegLevel Brain */
"use strict";

/* ------------------------------------------------------------------ */
/*  SRM color map (matches KegLevel app.js)                           */
/* ------------------------------------------------------------------ */
const SRM_HEX_MAP = {
   0:"#FFFFFF", 1:"#FFE699", 2:"#FFD878", 3:"#FFCA5A", 4:"#FFBF42",
   5:"#FBB123", 6:"#F8A600", 7:"#F39C00", 8:"#EA8F00", 9:"#E58500",
  10:"#DE7C00",11:"#D77200",12:"#CF6900",13:"#CB6200",14:"#C35900",
  15:"#BB5100",16:"#B54C00",17:"#B04500",18:"#A63E00",19:"#A13700",
  20:"#9B3200",21:"#962D00",22:"#8F2900",23:"#882300",24:"#821E00",
  25:"#7B1A00",26:"#771900",27:"#701400",28:"#6A0E00",29:"#660D00",
  30:"#5E0B00",31:"#5A0A02",32:"#600903",33:"#520907",34:"#4C0505",
  35:"#470606",36:"#440607",37:"#3F0708",38:"#3B0607",39:"#3A070B",
  40:"#36080A"
};

function srmHex(srm) {
  if (srm == null || srm < 0) return "#E5A128";
  const v = Math.min(40, Math.max(0, Math.round(srm)));
  return SRM_HEX_MAP[v] || "#E5A128";
}

function srmTextColor(srm) {
  if (srm == null || srm < 0) return "#000";
  return Math.round(srm) <= 10 ? "#000" : "#fff";
}

/* ------------------------------------------------------------------ */
/*  Global state                                                      */
/* ------------------------------------------------------------------ */
let BASE = "";
let beverages = [];
let bevMap = {};
let workflow = null;

const COLUMN_KEYS = ["rotation", "deck", "fermenting", "finishing"];
const COLUMN_DATA_KEYS = ["on_rotation", "on_deck", "fermenting", "lagering_or_finishing"];

let dragSrcCol = null;
let dragSrcIdx = -1;
let dragBevId = null;

/* ------------------------------------------------------------------ */
/*  Dev-mode detection                                                */
/* ------------------------------------------------------------------ */
function initDevMode() {
  BASE = "";
}

/* ------------------------------------------------------------------ */
/*  API helpers                                                       */
/* ------------------------------------------------------------------ */
async function apiFetch(path, opts) {
  const res = await fetch(BASE + path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function loadBeverages() {
  const list = await apiFetch("/api/beverages");
  beverages = Array.isArray(list) ? list : [];
  bevMap = {};
  beverages.forEach(b => { bevMap[b.id] = b; });
}

async function loadWorkflow() {
  try {
    workflow = await apiFetch("/api/batchflow");
  } catch (e) {
    console.warn("BatchFlow API not available, using defaults:", e.message);
    workflow = {};
  }
  if (!workflow.columns) workflow.columns = { on_rotation:[], on_deck:[], fermenting:[], lagering_or_finishing:[] };
  if (!workflow.titles) workflow.titles = { rotation:"On Rotation", deck:"On Deck", fermenting:"Fermenting", finishing:"Finishing" };
  if (!workflow.collapsed) workflow.collapsed = { rotation:false, deck:false, fermenting:false, finishing:false };
}

async function saveWorkflow() {
  try {
    await apiFetch("/api/batchflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workflow),
    });
  } catch (e) {
    console.error("Failed to save workflow:", e);
  }
}

function setStatus(msg, ok) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("connected", !!ok);
}

async function loadAll() {
  try {
    setStatus("Connecting...", false);
    await Promise.all([loadBeverages(), loadWorkflow()]);
    setStatus("Connected", true);
    renderBoard();
  } catch (e) {
    console.error(e);
    setStatus("Connection failed", false);
  }
}

/* ------------------------------------------------------------------ */
/*  Column data helpers                                               */
/* ------------------------------------------------------------------ */
function colDataKey(colKey) {
  const i = COLUMN_KEYS.indexOf(colKey);
  return COLUMN_DATA_KEYS[i];
}

function getColumnList(colKey) {
  return workflow.columns[colDataKey(colKey)] || [];
}

function setColumnList(colKey, list) {
  workflow.columns[colDataKey(colKey)] = list;
}

/* ------------------------------------------------------------------ */
/*  Render board                                                      */
/* ------------------------------------------------------------------ */
function renderBoard() {
  const board = document.getElementById("board");
  board.innerHTML = "";
  COLUMN_KEYS.forEach(key => {
    board.appendChild(buildColumn(key));
  });
}

function buildColumn(colKey) {
  const col = document.createElement("div");
  col.className = "bf-column";
  col.dataset.col = colKey;

  const isCollapsed = workflow.collapsed[colKey];
  if (isCollapsed) col.classList.add("collapsed");

  // Expanded header
  const header = document.createElement("div");
  header.className = "bf-col-header";
  const headerText = document.createElement("span");
  headerText.className = "bf-col-header-text";
  headerText.textContent = workflow.titles[colKey];
  header.appendChild(headerText);

  header.addEventListener("dblclick", () => {
    startRename(colKey, header);
  });

  col.appendChild(header);

  // Collapsed vertical header
  const vertHeader = document.createElement("div");
  vertHeader.className = "bf-col-header-vert";
  vertHeader.textContent = workflow.titles[colKey];
  vertHeader.addEventListener("click", () => toggleCollapse(colKey));
  col.appendChild(vertHeader);

  // Add batch button
  const addBtn = document.createElement("button");
  addBtn.className = "bf-add-btn";
  addBtn.textContent = "+ Add Batch";
  addBtn.addEventListener("click", () => openSelector(colKey));
  col.appendChild(addBtn);

  // Card list with drop zone
  const cardList = document.createElement("div");
  cardList.className = "bf-card-list";
  cardList.dataset.col = colKey;
  setupDropZone(cardList, colKey);

  const items = getColumnList(colKey);
  items.forEach((bevId, idx) => {
    const bev = bevMap[bevId];
    if (!bev) return;
    cardList.appendChild(buildCard(bev, colKey, idx));
  });

  // Wrap card list + panels in a relative container
  const body = document.createElement("div");
  body.style.cssText = "position:relative;flex:1;display:flex;flex-direction:column;overflow:hidden;";
  body.appendChild(cardList);

  // Selector panel (hidden)
  body.appendChild(buildSelectorPanel(colKey));
  // Editor panel (hidden)
  body.appendChild(buildEditorPanel(colKey));

  col.appendChild(body);
  return col;
}

/* ------------------------------------------------------------------ */
/*  Batch cards                                                       */
/* ------------------------------------------------------------------ */
function buildCard(bev, colKey, idx) {
  const card = document.createElement("div");
  card.className = "bf-card";
  card.draggable = true;
  card.dataset.bevId = bev.id;
  card.dataset.col = colKey;
  card.dataset.idx = idx;

  const bg = srmHex(bev.srm);
  const fg = srmTextColor(bev.srm);
  card.style.background = bg;
  card.style.color = fg;

  const row1 = document.createElement("div");
  row1.className = "bf-card-row";
  const name = document.createElement("span");
  name.className = "bf-card-name";
  name.textContent = bev.name || "Unknown";
  row1.appendChild(name);
  card.appendChild(row1);

  const row2 = document.createElement("div");
  row2.className = "bf-card-row";
  const style = document.createElement("span");
  style.className = "bf-card-style";
  style.textContent = bev.style || "";
  row2.appendChild(style);
  const statsParts = [];
  const abvVal = parseFloat(bev.abv);
  if (abvVal > 0) statsParts.push(abvVal + "% ABV");
  if (bev.ibu != null && bev.ibu !== "") statsParts.push(bev.ibu + " IBU");
  const stats = document.createElement("span");
  stats.className = "bf-card-stats";
  stats.textContent = statsParts.join(" \u2022 ");
  row2.appendChild(stats);
  card.appendChild(row2);

  // Edit button
  const editBtn = document.createElement("button");
  editBtn.className = "bf-card-edit";
  editBtn.textContent = "\u270E";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditor(colKey, bev.id);
  });
  card.appendChild(editBtn);

  // Drag events
  card.addEventListener("dragstart", (e) => {
    dragSrcCol = colKey;
    dragSrcIdx = idx;
    dragBevId = bev.id;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", bev.id);
    showTrash(true);
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    showTrash(false);
    clearDropIndicators();
  });

  return card;
}

/* ------------------------------------------------------------------ */
/*  Drag & drop                                                       */
/* ------------------------------------------------------------------ */
function setupDropZone(cardList, colKey) {
  cardList.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    cardList.classList.add("drag-over");
    showDropIndicator(cardList, e.clientY);
  });

  cardList.addEventListener("dragleave", (e) => {
    if (!cardList.contains(e.relatedTarget)) {
      cardList.classList.remove("drag-over");
      removeDropIndicator(cardList);
    }
  });

  cardList.addEventListener("drop", (e) => {
    e.preventDefault();
    cardList.classList.remove("drag-over");
    removeDropIndicator(cardList);

    if (dragBevId == null) return;
    const targetIdx = getDropIndex(cardList, e.clientY);
    moveBatch(dragSrcCol, colKey, dragBevId, dragSrcIdx, targetIdx);
    dragSrcCol = null;
    dragSrcIdx = -1;
    dragBevId = null;
  });
}

function getDropIndex(cardList, clientY) {
  const cards = cardList.querySelectorAll(".bf-card");
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

function showDropIndicator(cardList, clientY) {
  removeDropIndicator(cardList);
  const indicator = document.createElement("div");
  indicator.className = "bf-drop-indicator";
  const cards = cardList.querySelectorAll(".bf-card");
  let inserted = false;
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      cardList.insertBefore(indicator, cards[i]);
      inserted = true;
      break;
    }
  }
  if (!inserted) cardList.appendChild(indicator);
}

function removeDropIndicator(cardList) {
  cardList.querySelectorAll(".bf-drop-indicator").forEach(el => el.remove());
}

function clearDropIndicators() {
  document.querySelectorAll(".bf-drop-indicator").forEach(el => el.remove());
  document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
}

function moveBatch(srcCol, destCol, bevId, srcIdx, destIdx) {
  const srcList = getColumnList(srcCol);
  const pos = srcIdx >= 0 && srcIdx < srcList.length && srcList[srcIdx] === bevId
    ? srcIdx : srcList.indexOf(bevId);
  if (pos === -1) return;

  const isCopy = srcCol === "rotation" && destCol !== "rotation";

  if (srcCol === destCol) {
    if (destIdx > pos) destIdx--;
    if (destIdx === pos) return;
    srcList.splice(pos, 1);
    srcList.splice(destIdx, 0, bevId);
    setColumnList(srcCol, srcList);
    saveWorkflow();
    renderBoard();
    return;
  }

  if (!isCopy) {
    srcList.splice(pos, 1);
    setColumnList(srcCol, srcList);
  }

  const destList = getColumnList(destCol);
  if (destIdx < 0) destIdx = 0;
  if (destIdx > destList.length) destIdx = destList.length;
  destList.splice(destIdx, 0, bevId);
  setColumnList(destCol, destList);

  saveWorkflow();
  renderBoard();
}

/* ------------------------------------------------------------------ */
/*  Trash dock                                                        */
/* ------------------------------------------------------------------ */
function showTrash(show) {
  const dock = document.getElementById("trash-dock");
  dock.classList.toggle("visible", show);
}

(function initTrash() {
  const dock = document.getElementById("trash-dock");

  dock.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dock.classList.add("drag-hover");
  });

  dock.addEventListener("dragleave", () => {
    dock.classList.remove("drag-hover");
  });

  dock.addEventListener("drop", (e) => {
    e.preventDefault();
    dock.classList.remove("drag-hover");
    if (dragBevId == null || dragSrcCol == null) return;

    const removeBevId = dragBevId;
    const removeSrcCol = dragSrcCol;
    const bev = bevMap[removeBevId];
    const colTitle = workflow.titles[removeSrcCol] || removeSrcCol;
    const bevName = bev ? bev.name : removeBevId;
    dragSrcCol = null;
    dragSrcIdx = -1;
    dragBevId = null;
    showConfirm(
      `Remove ${bevName} from the ${colTitle} list?`,
      () => {
        const list = getColumnList(removeSrcCol);
        const pos = list.indexOf(removeBevId);
        if (pos !== -1) list.splice(pos, 1);
        setColumnList(removeSrcCol, list);
        saveWorkflow();
        renderBoard();
      }
    );
  });
})();

/* ------------------------------------------------------------------ */
/*  Confirm dialog                                                    */
/* ------------------------------------------------------------------ */
let confirmOkHandler = null;

function showConfirm(msg, onOk) {
  document.getElementById("confirm-msg").textContent = msg;
  document.getElementById("confirm-overlay").style.display = "flex";
  confirmOkHandler = onOk;
}

document.getElementById("btn-confirm-cancel").addEventListener("click", () => {
  document.getElementById("confirm-overlay").style.display = "none";
  confirmOkHandler = null;
  renderBoard();
});

document.getElementById("btn-confirm-ok").addEventListener("click", () => {
  document.getElementById("confirm-overlay").style.display = "none";
  if (confirmOkHandler) confirmOkHandler();
  confirmOkHandler = null;
});

/* ------------------------------------------------------------------ */
/*  Column collapse / rename                                          */
/* ------------------------------------------------------------------ */
function toggleCollapse(colKey) {
  workflow.collapsed[colKey] = !workflow.collapsed[colKey];
  saveWorkflow();
  renderBoard();
}

function startRename(colKey, headerEl) {
  if (workflow.collapsed[colKey]) return;
  const existing = headerEl.querySelector(".bf-rename-input");
  if (existing) return;

  const span = headerEl.querySelector(".bf-col-header-text");
  span.style.display = "none";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "bf-rename-input";
  input.value = workflow.titles[colKey];
  input.maxLength = 24;
  headerEl.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    if (val && val !== workflow.titles[colKey]) {
      workflow.titles[colKey] = val;
      saveWorkflow();
    }
    input.remove();
    span.style.display = "";
    span.textContent = workflow.titles[colKey];
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = workflow.titles[colKey]; input.blur(); }
  });
}

/* ------------------------------------------------------------------ */
/*  Beverage selector panel                                           */
/* ------------------------------------------------------------------ */
function openSelector(colKey) {
  const col = document.querySelector(`.bf-column[data-col="${colKey}"]`);
  const panel = col.querySelector(".bf-selector-panel");
  const list = panel.querySelector(".bf-panel-body");
  list.innerHTML = "";

  // "New beverage" button at top
  const newBtn = document.createElement("button");
  newBtn.className = "bf-bev-item bf-bev-new";
  newBtn.textContent = "+ New Beverage";
  newBtn.addEventListener("click", () => {
    closePanel(colKey, "selector");
    openEditor(colKey, null);
  });
  list.appendChild(newBtn);

  // Sort beverages alphabetically
  const sorted = [...beverages].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  sorted.forEach(bev => {
    const btn = document.createElement("button");
    btn.className = "bf-bev-item";
    btn.textContent = bev.name;
    btn.addEventListener("click", () => {
      addBatch(colKey, bev.id);
      closePanel(colKey, "selector");
    });
    list.appendChild(btn);
  });

  showPanel(colKey, "selector");
}

function addBatch(colKey, bevId) {
  const list = getColumnList(colKey);
  list.unshift(bevId);
  setColumnList(colKey, list);
  saveWorkflow();
  renderBoard();
}

/* ------------------------------------------------------------------ */
/*  Beverage editor panel                                             */
/* ------------------------------------------------------------------ */
function openEditor(colKey, bevId) {
  const col = document.querySelector(`.bf-column[data-col="${colKey}"]`);
  const panel = col.querySelector(".bf-editor-panel");
  const isNew = !bevId;
  const bev = isNew ? { name: "", abv: 0, ibu: 0, srm: 5 } : { ...bevMap[bevId] };

  panel.querySelector(".bf-panel-header").textContent = isNew ? "Create Beverage" : "Edit Beverage";

  const nameInput = panel.querySelector(".bf-ed-name");
  nameInput.value = bev.name || "";

  const abvSlider = panel.querySelector(".bf-ed-abv");
  const abvVal = panel.querySelector(".bf-ed-abv-val");
  abvSlider.value = bev.abv || 0;
  abvVal.textContent = Number(bev.abv || 0).toFixed(1) + "%";

  const ibuSlider = panel.querySelector(".bf-ed-ibu");
  const ibuVal = panel.querySelector(".bf-ed-ibu-val");
  ibuSlider.value = bev.ibu || 0;
  ibuVal.textContent = String(Math.round(bev.ibu || 0));

  const srmSlider = panel.querySelector(".bf-ed-srm");
  const srmVal = panel.querySelector(".bf-ed-srm-val");
  const srmPreview = panel.querySelector(".bf-srm-preview");
  const srmNum = bev.srm != null ? bev.srm : 5;
  srmSlider.value = srmNum;
  srmVal.textContent = String(Math.round(srmNum));
  srmPreview.style.background = srmHex(srmNum);

  // Delete row visibility
  const deleteRow = panel.querySelector(".bf-ed-delete-row");
  deleteRow.style.display = isNew ? "none" : "flex";
  const deleteConfirm = panel.querySelector(".bf-ed-delete-confirm");
  if (deleteConfirm) deleteConfirm.style.display = "none";
  const deleteBtn = panel.querySelector(".bf-ed-delete-btn");
  if (deleteBtn) deleteBtn.style.display = "";

  // Store context
  panel.dataset.bevId = bevId || "";
  panel.dataset.colKey = colKey;

  showPanel(colKey, "editor");
}

function buildEditorPanel(colKey) {
  const panel = document.createElement("div");
  panel.className = "bf-panel bf-editor-panel";

  const header = document.createElement("div");
  header.className = "bf-panel-header";
  header.textContent = "Create Beverage";
  panel.appendChild(header);

  const form = document.createElement("div");
  form.className = "bf-editor-form";

  // Name
  const nameField = document.createElement("div");
  nameField.className = "bf-field";
  nameField.innerHTML = '<label>Name</label>';
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "bf-ed-name";
  nameInput.placeholder = "Beverage name";
  nameField.appendChild(nameInput);
  form.appendChild(nameField);

  // ABV
  form.appendChild(buildSliderField("ABV %", "bf-ed-abv", "bf-ed-abv-val", 0, 15, 0.1, 0, v => v.toFixed(1) + "%"));

  // IBU
  form.appendChild(buildSliderField("IBU", "bf-ed-ibu", "bf-ed-ibu-val", 0, 120, 1, 0, v => String(Math.round(v))));

  // SRM
  const srmField = buildSliderField("SRM", "bf-ed-srm", "bf-ed-srm-val", 0, 40, 1, 5, v => String(Math.round(v)));
  const srmRow = srmField.querySelector(".bf-field-slider");
  const preview = document.createElement("div");
  preview.className = "bf-srm-preview";
  preview.style.background = srmHex(5);
  srmRow.appendChild(preview);

  const srmSlider = srmField.querySelector("input[type=range]");
  srmSlider.addEventListener("input", () => {
    preview.style.background = srmHex(Number(srmSlider.value));
  });
  form.appendChild(srmField);

  panel.appendChild(form);

  // Footer
  const footer = document.createElement("div");
  footer.className = "bf-editor-footer";

  const btnRow = document.createElement("div");
  btnRow.className = "bf-btn-row";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "bf-btn-cancel";
  cancelBtn.textContent = "BACK";
  cancelBtn.addEventListener("click", () => {
    closePanel(colKey, "editor");
  });
  btnRow.appendChild(cancelBtn);

  const saveBtn = document.createElement("button");
  saveBtn.className = "bf-btn-save";
  saveBtn.textContent = "SAVE";
  saveBtn.addEventListener("click", () => editorSave(colKey, panel));
  btnRow.appendChild(saveBtn);
  footer.appendChild(btnRow);

  // Delete row
  const deleteRow = document.createElement("div");
  deleteRow.className = "bf-btn-row bf-ed-delete-row";
  deleteRow.style.display = "none";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "bf-btn-delete bf-ed-delete-btn";
  deleteBtn.textContent = "REMOVE BEVERAGE";
  deleteBtn.addEventListener("click", () => {
    deleteBtn.style.display = "none";
    deleteConfirm.style.display = "flex";
  });
  deleteRow.appendChild(deleteBtn);

  const deleteConfirm = document.createElement("div");
  deleteConfirm.className = "bf-btn-row bf-ed-delete-confirm";
  deleteConfirm.style.display = "none";
  const delCancel = document.createElement("button");
  delCancel.className = "bf-btn-cancel";
  delCancel.textContent = "CANCEL";
  delCancel.addEventListener("click", () => {
    deleteConfirm.style.display = "none";
    deleteBtn.style.display = "";
  });
  deleteConfirm.appendChild(delCancel);
  const delOk = document.createElement("button");
  delOk.className = "bf-btn-danger";
  delOk.textContent = "CONFIRM REMOVE";
  delOk.addEventListener("click", () => editorRemove(colKey, panel));
  deleteConfirm.appendChild(delOk);
  deleteRow.appendChild(deleteConfirm);

  footer.appendChild(deleteRow);
  panel.appendChild(footer);

  return panel;
}

function buildSliderField(label, sliderClass, valClass, min, max, step, initial, fmt) {
  const field = document.createElement("div");
  field.className = "bf-field";
  field.innerHTML = `<label>${label}</label>`;

  const row = document.createElement("div");
  row.className = "bf-field-slider";

  const minus = document.createElement("button");
  minus.className = "bf-fine-btn";
  minus.textContent = "-";
  row.appendChild(minus);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = sliderClass;
  slider.min = min;
  slider.max = max;
  slider.step = step;
  slider.value = initial;
  row.appendChild(slider);

  const plus = document.createElement("button");
  plus.className = "bf-fine-btn";
  plus.textContent = "+";
  row.appendChild(plus);

  const val = document.createElement("span");
  val.className = "bf-field-value " + valClass;
  val.textContent = fmt(initial);
  row.appendChild(val);

  slider.addEventListener("input", () => { val.textContent = fmt(Number(slider.value)); });
  minus.addEventListener("click", () => {
    slider.value = Math.max(min, Number(slider.value) - step);
    slider.dispatchEvent(new Event("input"));
  });
  plus.addEventListener("click", () => {
    slider.value = Math.min(max, Number(slider.value) + Number(step));
    slider.dispatchEvent(new Event("input"));
  });

  field.appendChild(row);
  return field;
}

async function editorSave(colKey, panel) {
  const bevId = panel.dataset.bevId;
  const isNew = !bevId;

  const name = panel.querySelector(".bf-ed-name").value.trim();
  if (!name) return;

  const abv = Number(panel.querySelector(".bf-ed-abv").value);
  const ibu = Math.round(Number(panel.querySelector(".bf-ed-ibu").value));
  const srm = Math.round(Number(panel.querySelector(".bf-ed-srm").value));

  const body = { name, abv: abv || "", ibu: ibu || "", srm };

  try {
    let saved;
    if (isNew) {
      saved = await apiFetch("/api/beverages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      addBatch(colKey, saved.id);
    } else {
      saved = await apiFetch(`/api/beverages/${bevId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    await loadBeverages();
    closePanel(colKey, "editor");
    renderBoard();
  } catch (e) {
    console.error("Save failed:", e);
  }
}

function editorRemove(colKey, panel) {
  const bevId = panel.dataset.bevId;
  if (!bevId) return;

  COLUMN_KEYS.forEach(key => {
    const list = getColumnList(key);
    const filtered = list.filter(id => id !== bevId);
    setColumnList(key, filtered);
  });

  saveWorkflow();
  closePanel(colKey, "editor");
  renderBoard();
}

/* ------------------------------------------------------------------ */
/*  Beverage selector panel builder                                   */
/* ------------------------------------------------------------------ */
function buildSelectorPanel(colKey) {
  const panel = document.createElement("div");
  panel.className = "bf-panel bf-selector-panel";

  const header = document.createElement("div");
  header.className = "bf-panel-header";
  header.textContent = "Select Beverage";
  panel.appendChild(header);

  const body = document.createElement("div");
  body.className = "bf-panel-body";
  panel.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "bf-panel-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "bf-btn-cancel";
  cancelBtn.textContent = "CANCEL";
  cancelBtn.addEventListener("click", () => closePanel(colKey, "selector"));
  footer.appendChild(cancelBtn);
  panel.appendChild(footer);

  return panel;
}

/* ------------------------------------------------------------------ */
/*  Panel show/hide                                                   */
/* ------------------------------------------------------------------ */
function showPanel(colKey, type) {
  const col = document.querySelector(`.bf-column[data-col="${colKey}"]`);
  const cls = type === "selector" ? ".bf-selector-panel" : ".bf-editor-panel";
  const panel = col.querySelector(cls);
  panel.classList.add("active");
}

function closePanel(colKey, type) {
  const col = document.querySelector(`.bf-column[data-col="${colKey}"]`);
  const cls = type === "selector" ? ".bf-selector-panel" : ".bf-editor-panel";
  const panel = col.querySelector(cls);
  panel.classList.remove("active");
}

/* ------------------------------------------------------------------ */
/*  Help overlay                                                      */
/* ------------------------------------------------------------------ */
document.getElementById("btn-help").addEventListener("click", () => {
  document.getElementById("help-overlay").style.display = "flex";
});

document.getElementById("btn-help-close").addEventListener("click", () => {
  document.getElementById("help-overlay").style.display = "none";
});

document.getElementById("help-overlay").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.style.display = "none";
  }
});

/* ------------------------------------------------------------------ */
/*  Init                                                              */
/* ------------------------------------------------------------------ */
initDevMode();
loadAll();
