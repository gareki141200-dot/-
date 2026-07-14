/* =========================================================
   献立ノート — アプリロジック
   すべてのデータは localStorage に保存され、外部には送信されません。
   ========================================================= */

const STORE = {
  recipes:   "kondate_recipes",
  history:   "kondate_history",
  exclusion: "kondate_exclusions",
  settings:  "kondate_settings",
  shopping:  "kondate_shopping"
};

function load(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(e){ return fallback; }
}
function save(key, value){
  try{ localStorage.setItem(key, JSON.stringify(value)); }
  catch(e){ console.error("保存に失敗しました", e); }
}

let state = {
  recipes:   load(STORE.recipes, []),
  history:   load(STORE.history, []),
  exclusion: load(STORE.exclusion, []),
  settings:  load(STORE.settings, { organicPreference: "normal" }),
  shopping:  load(STORE.shopping, []),
  currentSuggestion: null,
  editingRecipeId: null,
  recipeFilter: "all"
};

/* ---------------- ナビゲーション ---------------- */
function showScreen(id){
  document.querySelectorAll("[data-screen]").forEach(s => s.hidden = (s.id !== id));
  document.querySelectorAll(".nav-btn").forEach(b=>{
    b.classList.toggle("active", b.dataset.nav === id);
  });
  if(id === "screen-recipe") renderRecipeList();
  if(id === "screen-shopping") renderShoppingList();
  if(id === "screen-settings") renderSettings();
  if(id === "screen-home") renderHome();
  window.scrollTo(0,0);
}

document.querySelectorAll(".nav-btn").forEach(btn=>{
  btn.addEventListener("click", ()=> showScreen(btn.dataset.nav));
});
document.querySelectorAll("[data-back]").forEach(btn=>{
  btn.addEventListener("click", ()=> showScreen(btn.dataset.back));
});

function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(()=> t.classList.remove("show"), 1800);
}

/* ---------------- ホーム画面 ---------------- */
function renderHome(){
  const dateEl = document.getElementById("home-date");
  const d = new Date();
  dateEl.textContent = d.toLocaleDateString("ja-JP", { year:"numeric", month:"long", day:"numeric", weekday:"short" });

  const listEl = document.getElementById("history-list");
  const countEl = document.getElementById("history-count");
  countEl.textContent = state.history.length + "件";

  if(state.history.length === 0){
    listEl.innerHTML = `<li class="empty-note">まだ履歴がありません。献立を決めると、ここに並びます。</li>`;
    return;
  }
  const recent = [...state.history].reverse().slice(0,8);
  listEl.innerHTML = recent.map(h=>`
    <li>
      <span class="hist-date">${h.date}</span>
      ${h.dishes.map(x=>x.name).join(" / ")}
    </li>
  `).join("");
}

/* ---------------- 献立提案エンジン ---------------- */
function getExclusionSet(){
  return new Set(state.exclusion.map(s=>s.trim()).filter(Boolean));
}

function containsExcluded(ingredients, exclusionSet){
  if(exclusionSet.size === 0) return false;
  return ingredients.some(([name]) =>
    [...exclusionSet].some(ex => name.includes(ex) || ex.includes(name))
  );
}

function candidatesForCategory(category, exclusionSet){
  const builtin = BUILTIN_DISHES[category].map(d => ({...d, source:"builtin"}));
  const own = state.recipes.filter(r=>r.category===category).map(r=>({
    name:r.name,
    ingredients: r.ingredients.map(i=>[i.name, i.amount, i.unit]),
    allergens: [],
    processedFree: r.processedFree,
    nutri: r.notes || "登録したご自身のレシピです。",
    source:"own"
  }));
  let pool = [...builtin, ...own].filter(d => !containsExcluded(d.ingredients, exclusionSet));

  if(state.settings.organicPreference === "strict"){
    const strict = pool.filter(d => d.processedFree);
    if(strict.length > 0) pool = strict;
  }
  return pool;
}

function pickAvoidingRepeat(pool, category){
  if(pool.length === 0) return null;
  const recentNames = new Set(
    state.history.slice(-3).flatMap(h => h.dishes.filter(x=>x.category===category).map(x=>x.name))
  );
  let fresh = pool.filter(d => !recentNames.has(d.name));
  if(fresh.length === 0) fresh = pool;
  return fresh[Math.floor(Math.random()*fresh.length)];
}

function generateSuggestion(){
  const exclusionSet = getExclusionSet();
  const categories = ["主菜","副菜","汁物"];
  const dishes = categories.map(cat=>{
    const pool = candidatesForCategory(cat, exclusionSet);
    const picked = pickAvoidingRepeat(pool, cat);
    return picked ? {...picked, category:cat} : null;
  });
  return dishes;
}

function renderSuggestion(){
  const dishes = generateSuggestion();
  state.currentSuggestion = dishes;
  const el = document.getElementById("dish-set");

  if(dishes.every(d=>!d)){
    el.innerHTML = `<div class="note-card"><p class="note-body">条件に合う候補が見つかりませんでした。設定画面で除外食材を見直すか、レシピを追加してみてください。</p></div>`;
    return;
  }

  el.innerHTML = dishes.map(d=>{
    if(!d) return "";
    const roleClass = d.category === "汁物" ? "dish-role soup" : "dish-role";
    const ingList = d.ingredients.map(i=>`${i[0]} ${i[1]}${i[2]}`).join("・");
    return `
      <div class="dish-card">
        <span class="${roleClass}">${d.category}</span>
        <p class="dish-name">${d.name}</p>
        <p class="dish-ing">${ingList}</p>
        <p class="dish-nutri"><b>栄養メモ:</b> ${d.nutri}</p>
        ${d.processedFree ? `<span class="dish-flag">🌿 加工食品を使わない構成</span>` : ""}
      </div>
    `;
  }).join("");
}

document.getElementById("btn-go-suggest").addEventListener("click", ()=>{
  showScreen("screen-suggest");
  renderSuggestion();
});
document.getElementById("btn-reroll").addEventListener("click", renderSuggestion);

document.getElementById("btn-decide").addEventListener("click", ()=>{
  const dishes = (state.currentSuggestion || []).filter(Boolean);
  if(dishes.length === 0){ toast("提案がありません"); return; }

  const dateStr = new Date().toLocaleDateString("ja-JP", { month:"numeric", day:"numeric", weekday:"short" });
  state.history.push({
    date: dateStr,
    dishes: dishes.map(d=>({ name:d.name, category:d.category }))
  });
  save(STORE.history, state.history);

  // 買い物リストに材料をマージ
  dishes.forEach(d=>{
    d.ingredients.forEach(([name, amount, unit])=>{
      const existing = state.shopping.find(s=> s.name===name && s.unit===unit && !s.checked);
      if(existing){
        const n1 = parseFloat(existing.amount), n2 = parseFloat(amount);
        if(!isNaN(n1) && !isNaN(n2)){
          existing.amount = String(n1+n2);
        } else {
          existing.amount = existing.amount + "＋" + amount;
        }
      } else {
        state.shopping.push({ name, amount, unit, checked:false });
      }
    });
  });
  save(STORE.shopping, state.shopping);

  toast("献立を記録し、買い物リストを更新しました");
  showScreen("screen-home");
});

/* ---------------- レシピ管理 ---------------- */
const BASE_CATEGORIES = ["主菜","副菜","汁物"];

function renderRecipeFilterChips(){
  const row = document.getElementById("recipe-filter");
  const customCats = [...new Set(state.recipes.map(r=>r.category))]
    .filter(c => !BASE_CATEGORIES.includes(c));

  // すべて・主菜・副菜・汁物 は固定。カスタムのカテゴリだけ末尾に追加/更新する
  row.querySelectorAll(".tab-chip[data-custom='1']").forEach(el=>el.remove());
  customCats.forEach(cat=>{
    const btn = document.createElement("button");
    btn.className = "tab-chip";
    btn.dataset.cat = cat;
    btn.dataset.custom = "1";
    btn.textContent = cat;
    if(state.recipeFilter === cat) btn.classList.add("active");
    row.appendChild(btn);
  });
}

function renderRecipeList(){
  renderRecipeFilterChips();
  const el = document.getElementById("recipe-list");
  const filtered = state.recipes.filter(r => state.recipeFilter==="all" || r.category===state.recipeFilter);
  if(filtered.length===0){
    el.innerHTML = `<li class="empty-note">レシピがまだありません。右上の「＋」から追加できます。</li>`;
    return;
  }
  el.innerHTML = filtered.map(r=>`
    <li class="recipe-item" data-id="${r.id}">
      <div>
        <p class="recipe-item-name">${r.name}</p>
        <p class="recipe-item-meta">${r.category} ・ 材料${r.ingredients.length}点${r.processedFree ? " ・ 🌿無添加志向" : ""}</p>
      </div>
      <span>›</span>
    </li>
  `).join("");
  el.querySelectorAll(".recipe-item").forEach(li=>{
    li.addEventListener("click", ()=> openRecipeForm(li.dataset.id));
  });
}

document.getElementById("recipe-filter").addEventListener("click", (e)=>{
  const chip = e.target.closest(".tab-chip");
  if(!chip) return;
  state.recipeFilter = chip.dataset.cat;
  document.querySelectorAll("#recipe-filter .tab-chip").forEach(c=>c.classList.toggle("active", c===chip));
  renderRecipeList();
});

function openRecipeForm(id){
  const modal = document.getElementById("modal-recipe");
  const form = document.getElementById("form-recipe");
  form.reset();
  document.getElementById("btn-delete-recipe").hidden = true;
  state.editingRecipeId = null;

  if(id){
    const r = state.recipes.find(x=>x.id===id);
    if(r){
      state.editingRecipeId = id;
      document.getElementById("recipe-form-title").textContent = "レシピを編集";
      document.getElementById("f-name").value = r.name;
      document.getElementById("f-category").value = r.category;
      document.getElementById("f-ingredients").value = r.ingredients.map(i=>`${i.name} ${i.amount} ${i.unit}`).join("\n");
      document.getElementById("f-processedfree").checked = r.processedFree;
      document.getElementById("f-notes").value = r.notes || "";
      document.getElementById("btn-delete-recipe").hidden = false;
    }
  } else {
    document.getElementById("recipe-form-title").textContent = "レシピを追加";
  }
  modal.hidden = false;
}
document.getElementById("btn-new-recipe").addEventListener("click", ()=> openRecipeForm(null));

// モーダルの背景(カードの外側)をタップしたら、保存せずに閉じる
document.getElementById("modal-recipe").addEventListener("click", (e)=>{
  if(e.target.id === "modal-recipe"){
    document.getElementById("modal-recipe").hidden = true;
  }
});

function parseIngredientsText(text){
  return text.split("\n").map(line=>line.trim()).filter(Boolean).map(line=>{
    const parts = line.split(/\s+/);
    if(parts.length >= 3){
      return { name: parts[0], amount: parts[1], unit: parts.slice(2).join("") };
    } else if(parts.length === 2){
      return { name: parts[0], amount: parts[1], unit: "" };
    }
    return { name: line, amount:"", unit:"" };
  });
}

document.getElementById("form-recipe").addEventListener("submit", (e)=>{
  e.preventDefault();
  const recipe = {
    id: state.editingRecipeId || ("r_" + Date.now()),
    name: document.getElementById("f-name").value.trim(),
    category: document.getElementById("f-category").value.trim(),
    ingredients: parseIngredientsText(document.getElementById("f-ingredients").value),
    processedFree: document.getElementById("f-processedfree").checked,
    notes: document.getElementById("f-notes").value.trim()
  };
  if(state.editingRecipeId){
    const idx = state.recipes.findIndex(r=>r.id===state.editingRecipeId);
    state.recipes[idx] = recipe;
  } else {
    state.recipes.push(recipe);
  }
  save(STORE.recipes, state.recipes);
  document.getElementById("modal-recipe").hidden = true;
  renderRecipeList();
  toast("レシピを保存しました");
});

document.getElementById("btn-delete-recipe").addEventListener("click", ()=>{
  if(!state.editingRecipeId) return;
  if(!confirm("このレシピを削除しますか?")) return;
  state.recipes = state.recipes.filter(r=>r.id !== state.editingRecipeId);
  save(STORE.recipes, state.recipes);
  document.getElementById("modal-recipe").hidden = true;
  renderRecipeList();
  toast("レシピを削除しました");
});

/* ---------------- 買い物リスト ---------------- */
function renderShoppingList(){
  const el = document.getElementById("shopping-list");
  if(state.shopping.length===0){
    el.innerHTML = `<li class="empty-note">買い物リストは空です。献立を決めると自動で追加されます。</li>`;
    return;
  }
  el.innerHTML = state.shopping.map((item, idx)=>`
    <li class="shop-item ${item.checked ? "checked":""}" data-idx="${idx}">
      <input type="checkbox" ${item.checked?"checked":""}>
      <span class="shop-item-name">${item.name}</span>
      <span class="shop-item-amount">${item.amount||""}${item.unit||""}</span>
      <button class="shop-del" aria-label="削除">✕</button>
    </li>
  `).join("");

  el.querySelectorAll(".shop-item").forEach(li=>{
    const idx = Number(li.dataset.idx);
    li.querySelector("input").addEventListener("change", (e)=>{
      state.shopping[idx].checked = e.target.checked;
      save(STORE.shopping, state.shopping);
      renderShoppingList();
    });
    li.querySelector(".shop-del").addEventListener("click", ()=>{
      state.shopping.splice(idx,1);
      save(STORE.shopping, state.shopping);
      renderShoppingList();
    });
  });
}

document.getElementById("form-add-item").addEventListener("submit", (e)=>{
  e.preventDefault();
  const nameInput = document.getElementById("new-item-name");
  const amountInput = document.getElementById("new-item-amount");
  if(!nameInput.value.trim()) return;
  state.shopping.push({ name:nameInput.value.trim(), amount:amountInput.value.trim(), unit:"", checked:false });
  save(STORE.shopping, state.shopping);
  nameInput.value = ""; amountInput.value = "";
  renderShoppingList();
});

document.getElementById("btn-clear-checked").addEventListener("click", ()=>{
  state.shopping = state.shopping.filter(i=>!i.checked);
  save(STORE.shopping, state.shopping);
  renderShoppingList();
});

/* ---------------- 設定 ---------------- */
function renderSettings(){
  const chipsEl = document.getElementById("exclusion-chips");
  chipsEl.innerHTML = state.exclusion.length===0
    ? `<span class="block-sub">まだ登録がありません</span>`
    : state.exclusion.map((ex, idx)=>`
        <span class="excl-chip">${ex}<button data-idx="${idx}">✕</button></span>
      `).join("");
  chipsEl.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.exclusion.splice(Number(btn.dataset.idx),1);
      save(STORE.exclusion, state.exclusion);
      renderSettings();
    });
  });

  document.querySelectorAll("#organic-pref input").forEach(r=>{
    r.checked = (r.value === state.settings.organicPreference);
  });
}

document.getElementById("form-add-exclusion").addEventListener("submit", (e)=>{
  e.preventDefault();
  const input = document.getElementById("new-exclusion");
  if(!input.value.trim()) return;
  input.value.split(/[、,]/).map(s=>s.trim()).filter(Boolean).forEach(v=>{
    if(!state.exclusion.includes(v)) state.exclusion.push(v);
  });
  save(STORE.exclusion, state.exclusion);
  input.value = "";
  renderSettings();
});

document.getElementById("organic-pref").addEventListener("change", (e)=>{
  if(e.target.name==="organic"){
    state.settings.organicPreference = e.target.value;
    save(STORE.settings, state.settings);
  }
});

document.getElementById("btn-reset-all").addEventListener("click", ()=>{
  if(!confirm("すべてのデータ(レシピ・履歴・買い物リスト・設定)を削除します。よろしいですか?")) return;
  Object.values(STORE).forEach(k=>localStorage.removeItem(k));
  state = { recipes:[], history:[], exclusion:[], settings:{organicPreference:"normal"}, shopping:[], currentSuggestion:null, editingRecipeId:null, recipeFilter:"all" };
  toast("初期化しました");
  showScreen("screen-home");
});

/* ---------------- 初期化 ---------------- */
renderHome();

if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  });
}
