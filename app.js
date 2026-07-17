/* =========================================================
   献立ノート — アプリロジック
   すべてのデータは localStorage に保存され、外部には送信されません。
   ========================================================= */

const STORE = {
  recipes:   "kondate_recipes",
  history:   "kondate_history",
  exclusion: "kondate_exclusions",
  settings:  "kondate_settings",
  shopping:  "kondate_shopping",
  apiKey:    "kondate_api_key"
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
  settings:  load(STORE.settings, { organicPreference: "normal", healthMode: false }),
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
    <li class="history-item" data-id="${h.id || ""}">
      <span class="hist-date">${h.date}</span>
      ${h.dishes.map(x=>x.name).join(" / ")}
    </li>
  `).join("");
  listEl.querySelectorAll(".history-item").forEach(li=>{
    if(!li.dataset.id) return; // 古い形式の履歴(詳細情報なし)はタップ不可
    li.addEventListener("click", ()=> openHistoryDetail(li.dataset.id));
  });
}

function openHistoryDetail(id){
  const entry = state.history.find(h => h.id === id);
  if(!entry) return;
  document.getElementById("history-detail-date").textContent = entry.date + "の献立";
  document.getElementById("history-detail-set").innerHTML = buildDishSetHtml(entry.dishes);
  showScreen("screen-history-detail");
}

/* ---------------- 献立提案エンジン ---------------- */
function getExclusionSet(){
  return new Set(state.exclusion.map(s=>s.trim()).filter(Boolean));
}

// 除外語(同義語・表記ゆれ展開済み)のリストを作る
function buildExpandedExclusionTerms(exclusionSet){
  let expanded = [];
  exclusionSet.forEach(term=>{
    expanded = expanded.concat(expandExclusionTerm(term));
  });
  return expanded.map(normalizeForMatch).filter(Boolean);
}

// 材料リストの中に、除外語(表記ゆれ・同義語を含む)が含まれていないか判定する
// アレルギー事故防止のため、判定はできるだけ広く(部分一致・表記ゆれ吸収)行う
function containsExcluded(ingredients, exclusionSet){
  if(exclusionSet.size === 0) return false;
  const expandedTerms = buildExpandedExclusionTerms(exclusionSet);
  return ingredients.some(([name]) => {
    const normName = normalizeForMatch(name);
    return expandedTerms.some(term => normName.includes(term) || term.includes(normName));
  });
}

function candidatesForCategory(category, exclusionSet){
  const builtin = BUILTIN_DISHES[category].map(d => ({...d, source:"builtin"}));
  const own = state.recipes.filter(r=>r.category===category).map(r=>({
    name:r.name,
    ingredients: r.ingredients.map(i=>[i.name, i.amount, i.unit]),
    allergens: [],
    processedFree: r.processedFree,
    nutri: r.notes || "登録したご自身のレシピです。",
    steps: r.steps || [],
    source:"own"
  }));
  let pool = [...builtin, ...own].filter(d => !containsExcluded(d.ingredients, exclusionSet));

  if(state.settings.organicPreference === "strict"){
    const strict = pool.filter(d => d.processedFree);
    if(strict.length > 0) pool = strict;
  }

  if(state.settings.healthMode){
    const sorted = [...pool].sort((a,b)=>
      estimateDishCalories(a.ingredients).totalKcal - estimateDishCalories(b.ingredients).totalKcal
    );
    // カロリーが低い順に、候補の半分程度(最低2件)に絞り込む
    const keepCount = Math.max(2, Math.ceil(sorted.length / 2));
    pool = sorted.slice(0, keepCount);
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
    let picked = pickAvoidingRepeat(pool, cat);

    // 安全網:万一、除外食材を含む料理が選ばれてしまっていないか最終確認する
    if(picked && containsExcluded(picked.ingredients, exclusionSet)){
      console.error("除外食材チェックの安全網が作動しました。この料理は表示されません:", picked.name);
      const safePool = pool.filter(d => !containsExcluded(d.ingredients, exclusionSet));
      picked = safePool.length > 0 ? pickAvoidingRepeat(safePool, cat) : null;
    }

    return picked ? {...picked, category:cat} : null;
  });
  return dishes;
}

/* ---------------- 材料から探す ---------------- */
// 常備している前提として「持ち合わせ判定」から除外する調味料など
const COMMON_STAPLES = [
  "塩","こしょう","醤油","みりん","酒","砂糖","サラダ油","ごま油","オリーブオイル",
  "バター","片栗粉","だし汁","水","酢","鶏がらだし","すりごま","揚げ油","マヨネーズ",
  "水溶き片栗粉"
];
function isStaple(name){
  return COMMON_STAPLES.some(s => name.includes(s));
}

function getAllDishesPool(){
  const exclusionSet = getExclusionSet();
  const categories = ["主菜","副菜","汁物"];
  let pool = [];
  categories.forEach(cat=>{
    pool = pool.concat(candidatesForCategory(cat, exclusionSet).map(d=>({...d, category:cat})));
  });
  return pool;
}

function searchDishesByIngredients(searchTerms, mode){
  const pool = getAllDishesPool();

  const scored = pool.map(d=>{
    const nonStaple = d.ingredients.filter(([name]) => !isStaple(name));
    const matched = nonStaple.filter(([name]) =>
      searchTerms.some(term => name.includes(term) || term.includes(name))
    );
    return { dish: d, matchedCount: matched.length, missingCount: nonStaple.length - matched.length, totalNeeded: nonStaple.length };
  });

  let filtered;
  if(mode === "strict"){
    // 手持ちの材料だけで作れるもの:非調味料の材料がすべて揃っているものだけ
    filtered = scored.filter(s => s.matchedCount > 0 && s.missingCount === 0);
  } else {
    // ゆるく提案:1つでも材料が一致すれば候補に含める
    filtered = scored.filter(s => s.matchedCount > 0);
  }

  filtered.sort((a,b)=> b.matchedCount - a.matchedCount || a.missingCount - b.missingCount);
  return filtered.map(s => s.dish);
}

document.getElementById("btn-go-ingredients").addEventListener("click", ()=>{
  showScreen("screen-ingredients");
});

document.getElementById("btn-search-ingredients").addEventListener("click", ()=>{
  const raw = document.getElementById("ingredient-search-input").value;
  const searchTerms = raw.split(/[、,\n]/).map(s=>s.trim()).filter(Boolean);
  const resultArea = document.getElementById("ingredient-search-result");

  if(searchTerms.length === 0){
    resultArea.innerHTML = `<div class="note-card"><p class="note-body">材料を1つ以上入力してください。</p></div>`;
    return;
  }

  const mode = document.querySelector('input[name="ingmode"]:checked').value;
  const results = searchDishesByIngredients(searchTerms, mode);

  if(results.length === 0){
    const hint = mode === "strict"
      ? "手持ちの材料だけで作れるレシピは見つかりませんでした。「ゆるく提案」に切り替えるか、材料を増やして試してみてください。"
      : "条件に合うレシピが見つかりませんでした。別の材料で試してみてください。";
    resultArea.innerHTML = `<div class="note-card"><p class="note-body">${hint}</p></div>`;
    return;
  }

  const countHtml = `<p class="block-sub" style="margin:16px 0 10px;">${results.length}件見つかりました</p>`;
  resultArea.innerHTML = countHtml + results.map(d => buildSingleDishCardHtml(d)).join("");
});

// 料理カード一式のHTMLを生成する共通関数(今日の提案・履歴詳細の両方で使う)
function buildSingleDishCardHtml(d){
  const roleClass = d.category === "汁物" ? "dish-role soup" : "dish-role";
  const ingList = d.ingredients.map(i=>`${i[0]} ${i[1]}${i[2]}`).join("・");
  const stepsHtml = (d.steps && d.steps.length > 0)
    ? `<ol class="dish-steps">${d.steps.map(s=>`<li>${s}</li>`).join("")}</ol>`
    : "";
  const cal = estimateDishCalories(d.ingredients);

  return `
    <div class="dish-card">
      <span class="${roleClass}">${d.category}</span>
      <p class="dish-name">${d.name}</p>
      <p class="dish-ing">${ingList}</p>
      ${stepsHtml}
      <p class="dish-nutri"><b>栄養メモ:</b> ${d.nutri}</p>
      <p class="dish-kcal">🔥 約${cal.totalKcal}kcal</p>
      ${d.processedFree ? `<span class="dish-flag">🌿 加工食品を使わない構成</span>` : ""}
    </div>
  `;
}

function buildDishSetHtml(dishes){
  let totalKcal = 0;
  let anyExcluded = false;

  const cardsHtml = dishes.map(d=>{
    if(!d) return "";
    const cal = estimateDishCalories(d.ingredients);
    totalKcal += cal.totalKcal;
    if(cal.excludedCount > 0) anyExcluded = true;
    return buildSingleDishCardHtml(d);
  }).join("");

  const totalHtml = `
    <div class="calorie-total-banner">
      この献立の合計:約${totalKcal}kcal
      ${anyExcluded ? '<span class="calorie-total-note">(一部の調味料等は計算に含まれていません)</span>' : ""}
    </div>
  `;

  return totalHtml + cardsHtml;
}

function renderSuggestion(){
  const dishes = generateSuggestion();
  state.currentSuggestion = dishes;
  const el = document.getElementById("dish-set");

  if(dishes.every(d=>!d)){
    el.innerHTML = `<div class="note-card"><p class="note-body">条件に合う候補が見つかりませんでした。設定画面で除外食材を見直すか、レシピを追加してみてください。</p></div>`;
    return;
  }

  el.innerHTML = buildDishSetHtml(dishes);
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
    id: "h_" + Date.now(),
    date: dateStr,
    dishes: dishes.map(d=>({
      name:d.name, category:d.category, ingredients:d.ingredients,
      steps:d.steps || [], nutri:d.nutri, processedFree:d.processedFree
    }))
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
  el.innerHTML = filtered.map(r=>{
    const cal = estimateDishCalories(r.ingredients);
    const calText = cal.excludedCount < r.ingredients.length ? `約${cal.totalKcal}kcal` : "kcal計算不可";
    return `
    <li class="recipe-item" data-id="${r.id}">
      <div>
        <p class="recipe-item-name">${r.name}</p>
        <p class="recipe-item-meta">${r.category} ・ 材料${r.ingredients.length}点${r.processedFree ? " ・ 🌿無添加志向" : ""} ・ 🔥${calText}</p>
      </div>
      <span>›</span>
    </li>
  `;
  }).join("");
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
  document.getElementById("form-error").hidden = true;
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
      document.getElementById("f-steps").value = (r.steps || []).join("\n");
      document.getElementById("f-processedfree").checked = r.processedFree;
      document.getElementById("f-notes").value = r.notes || "";
      document.getElementById("btn-delete-recipe").hidden = false;
    }
  } else {
    document.getElementById("recipe-form-title").textContent = "レシピを追加";
  }
  // CSSの状態に依存せず、確実に表示されるようインラインスタイルで直接指定する
  modal.style.display = "flex";
  modal.hidden = false;
}
document.getElementById("btn-new-recipe").addEventListener("click", ()=> openRecipeForm(null));

function closeRecipeModal(){
  const modal = document.getElementById("modal-recipe");
  // CSSの状態に依存せず、確実に非表示になるようインラインスタイルで直接指定する
  modal.style.display = "none";
  modal.hidden = true;
  document.getElementById("form-recipe").reset();
  document.getElementById("form-error").hidden = true;
}
document.getElementById("btn-close-recipe").addEventListener("click", closeRecipeModal);

// モーダルの背景(カードの外側)をタップしたら、保存せずに閉じる
document.getElementById("modal-recipe").addEventListener("click", (e)=>{
  if(e.target.id === "modal-recipe"){
    closeRecipeModal();
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

  const errorEl = document.getElementById("form-error");
  errorEl.hidden = true;

  const name = document.getElementById("f-name").value.trim();
  const category = document.getElementById("f-category").value.trim();

  // 入力チェック(ブラウザ標準のエラー表示はスクロール内に隠れて見えないことがあるため、
  // 自前でわかりやすく表示する)
  if(!name || !category){
    errorEl.textContent = !name
      ? "料理名を入力してください。"
      : "種類を入力してください(例:主菜)。";
    errorEl.hidden = false;
    errorEl.scrollIntoView({ block:"center", behavior:"smooth" });
    return; // ここで処理を止め、モーダルは閉じない
  }

  const recipe = {
    id: state.editingRecipeId || ("r_" + Date.now()),
    name: name,
    category: category,
    ingredients: parseIngredientsText(document.getElementById("f-ingredients").value),
    steps: document.getElementById("f-steps").value.split("\n").map(s=>s.trim()).filter(Boolean),
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
  closeRecipeModal();
  renderRecipeList();
  toast("レシピを保存しました");
});

document.getElementById("btn-delete-recipe").addEventListener("click", ()=>{
  if(!state.editingRecipeId) return;
  if(!confirm("このレシピを削除しますか?")) return;
  state.recipes = state.recipes.filter(r=>r.id !== state.editingRecipeId);
  save(STORE.recipes, state.recipes);
  closeRecipeModal();
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

  document.getElementById("f-health-mode").checked = !!state.settings.healthMode;
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

document.getElementById("f-health-mode").addEventListener("change", (e)=>{
  state.settings.healthMode = e.target.checked;
  save(STORE.settings, state.settings);
});

document.getElementById("btn-reset-all").addEventListener("click", ()=>{
  if(!confirm("すべてのデータ(レシピ・履歴・買い物リスト・設定)を削除します。よろしいですか?")) return;
  Object.values(STORE).forEach(k=>localStorage.removeItem(k));
  state = { recipes:[], history:[], exclusion:[], settings:{organicPreference:"normal", healthMode:false}, shopping:[], currentSuggestion:null, editingRecipeId:null, recipeFilter:"all" };
  toast("初期化しました");
  showScreen("screen-home");
});

/* ---------------- AI機能(APIキー) ---------------- */
function updateApiKeyFieldPlaceholder(){
  const input = document.getElementById("f-api-key");
  const saved = localStorage.getItem(STORE.apiKey);
  input.value = "";
  input.placeholder = saved ? "登録済み(変更する場合のみ入力)" : "sk-ant-...";
}
updateApiKeyFieldPlaceholder();

document.getElementById("btn-save-api-key").addEventListener("click", ()=>{
  const input = document.getElementById("f-api-key");
  const value = input.value.trim();
  if(!value){
    toast("APIキーを入力してください");
    return;
  }
  localStorage.setItem(STORE.apiKey, value);
  updateApiKeyFieldPlaceholder();
  toast("APIキーを保存しました");
});

/* ---------------- 写真からカロリー計算 ---------------- */
let calorieImageData = null; // { base64, mediaType }

document.getElementById("btn-go-calorie").addEventListener("click", ()=>{
  showScreen("screen-calorie");
});

document.getElementById("calorie-photo-input").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(!file) return;

  const reader = new FileReader();
  reader.onload = ()=>{
    const dataUrl = reader.result; // "data:image/jpeg;base64,xxxxx"
    const base64 = dataUrl.split(",")[1];
    calorieImageData = { base64, mediaType: file.type || "image/jpeg" };

    const preview = document.getElementById("calorie-photo-preview");
    preview.src = dataUrl;
    preview.hidden = false;
    document.getElementById("photo-picker-text").textContent = "📷 別の写真に変える";
    document.getElementById("btn-calc-calorie").disabled = false;
    document.getElementById("calorie-result-area").innerHTML = "";
  };
  reader.readAsDataURL(file);
});

document.getElementById("btn-calc-calorie").addEventListener("click", async ()=>{
  const resultArea = document.getElementById("calorie-result-area");
  const apiKey = localStorage.getItem(STORE.apiKey);

  if(!apiKey){
    resultArea.innerHTML = `<div class="note-card"><p class="note-body">先に設定画面でAnthropic APIキーを登録してください。</p></div>`;
    return;
  }
  if(!calorieImageData){
    toast("先に写真を選んでください");
    return;
  }

  const calcBtn = document.getElementById("btn-calc-calorie");
  calcBtn.disabled = true;
  resultArea.innerHTML = `<p class="calorie-loading">AIが写真を解析しています…</p>`;

  try{
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              { type:"image", source:{ type:"base64", media_type: calorieImageData.mediaType, data: calorieImageData.base64 } },
              { type:"text", text:
                "この写真に写っている食事について、写っている料理・食材ごとにおおよその分量とカロリー(kcal)を推定してください。" +
                "推定はあくまで目安であることを前提に、次のJSON形式のみを出力してください。他の文章やMarkdownの記号は一切含めないでください。\n" +
                '{"foods":[{"name":"料理名","amount":"目安の分量","kcal":数値}],"total_kcal":合計の数値,"note":"推定に関する簡単な注意点(1文)"}'
              }
            ]
          }
        ]
      })
    });

    if(!response.ok){
      const errBody = await response.json().catch(()=>null);
      const msg = errBody && errBody.error && errBody.error.message ? errBody.error.message : `HTTPエラー ${response.status}`;
      throw new Error(msg);
    }

    const data = await response.json();
    const rawText = (data.content || []).map(c=>c.text || "").join("").trim();
    const cleaned = rawText.replace(/^```json/i, "").replace(/^```/,"").replace(/```$/,"").trim();
    const parsed = JSON.parse(cleaned);

    renderCalorieResult(parsed);

  }catch(err){
    console.error(err);
    resultArea.innerHTML = `<div class="note-card"><p class="note-body">計算に失敗しました。APIキーが正しいか、通信環境をご確認のうえもう一度お試しください。(${(err.message||"").slice(0,80)})</p></div>`;
  }finally{
    calcBtn.disabled = false;
  }
});

function renderCalorieResult(parsed){
  const resultArea = document.getElementById("calorie-result-area");
  const foods = Array.isArray(parsed.foods) ? parsed.foods : [];

  const foodListHtml = foods.map(f=>`
    <li><span>${f.name || "不明"}${f.amount ? "(" + f.amount + ")" : ""}</span><span>${f.kcal ?? "?"} kcal</span></li>
  `).join("");

  resultArea.innerHTML = `
    <div class="calorie-result-card">
      <p class="calorie-total">合計 約${parsed.total_kcal ?? "?"} kcal</p>
      <ul class="calorie-food-list">${foodListHtml}</ul>
      <p class="note-body">${parsed.note || "AIによる目安の推定値です。実際の栄養量とは異なる場合があります。"}</p>
    </div>
  `;
}

document.getElementById("btn-go-ai-recipe").addEventListener("click", ()=>{
  showScreen("screen-ai-recipe");
});

/* ---------------- 材料からAIにレシピを考えてもらう ---------------- */
let lastAiRecipe = null; // 保存ボタン用に、直近でAIが考えたレシピを保持しておく

document.getElementById("btn-generate-ai-recipe").addEventListener("click", async ()=>{
  const resultArea = document.getElementById("ai-recipe-result-area");
  const apiKey = localStorage.getItem(STORE.apiKey);
  const rawInput = document.getElementById("ai-recipe-ingredients-input").value.trim();

  if(!apiKey){
    resultArea.innerHTML = `<div class="note-card"><p class="note-body">先に設定画面でAnthropic APIキーを登録してください。</p></div>`;
    return;
  }
  if(!rawInput){
    toast("材料を入力してください");
    return;
  }

  const genBtn = document.getElementById("btn-generate-ai-recipe");
  genBtn.disabled = true;
  resultArea.innerHTML = `<p class="calorie-loading">AIがレシピを考えています…</p>`;
  lastAiRecipe = null;

  const exclusionSet = getExclusionSet();
  const exclusionList = [...exclusionSet];
  const exclusionText = exclusionList.length > 0
    ? `【厳守】次の食材とその関連食材は、アレルギー・除外設定のため絶対に使用しないでください。少しでも含まれる可能性がある食材(加工品や派生食材を含む)は避けてください:${exclusionList.join("、")}\n`
    : "";

  try{
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              { type:"text", text:
                exclusionText +
                `次の材料を使って、家庭で作れる料理を1品考えてください。材料:${rawInput}\n` +
                "この材料に加えて、塩・醤油・油・砂糖などの基本的な調味料は自由に使ってよいものとします。" +
                "できるだけ加工食品や添加物に頼らない構成にしてください。" +
                "次のJSON形式のみを出力してください。他の文章やMarkdownの記号は一切含めないでください。\n" +
                '{"name":"料理名","category":"主菜、副菜、汁物のいずれか","ingredients":[{"name":"材料名","amount":"数量","unit":"単位"}],"steps":["手順1","手順2"],"nutri":"栄養に関する一般的なひとことメモ(医療的な断定は避ける)","processedFree":true}'
              }
            ]
          }
        ]
      })
    });

    if(!response.ok){
      const errBody = await response.json().catch(()=>null);
      const msg = errBody && errBody.error && errBody.error.message ? errBody.error.message : `HTTPエラー ${response.status}`;
      throw new Error(msg);
    }

    const data = await response.json();
    const rawText = (data.content || []).map(c=>c.text || "").join("").trim();
    const cleaned = rawText.replace(/^```json/i, "").replace(/^```/,"").replace(/```$/,"").trim();
    const parsed = JSON.parse(cleaned);

    // 安全網:AIの回答にも念のため、除外食材が含まれていないかローカルで再確認する
    const parsedIngredientsAsTriples = (Array.isArray(parsed.ingredients) ? parsed.ingredients : [])
      .map(i => [i.name || "", i.amount || "", i.unit || ""]);

    if(containsExcluded(parsedIngredientsAsTriples, exclusionSet)){
      resultArea.innerHTML = `<div class="note-card"><p class="note-body">⚠️ AIが提案したレシピに、登録されている除外食材・アレルギー食材が含まれている可能性があるため、表示を中止しました。材料を変えてもう一度お試しください。</p></div>`;
      return;
    }

    lastAiRecipe = parsed;
    renderAiRecipeResult(parsed);

  }catch(err){
    console.error(err);
    resultArea.innerHTML = `<div class="note-card"><p class="note-body">レシピの生成に失敗しました。APIキーが正しいか、通信環境をご確認のうえもう一度お試しください。(${(err.message||"").slice(0,80)})</p></div>`;
  }finally{
    genBtn.disabled = false;
  }
});

function renderAiRecipeResult(parsed){
  const resultArea = document.getElementById("ai-recipe-result-area");
  const ingredientsArr = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];

  const displayDish = {
    name: parsed.name || "AIが考えた料理",
    category: parsed.category || "主菜",
    ingredients: ingredientsArr.map(i => [i.name || "", i.amount || "", i.unit || ""]),
    steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    nutri: parsed.nutri || "",
    processedFree: !!parsed.processedFree
  };

  resultArea.innerHTML = buildSingleDishCardHtml(displayDish) +
    `<button class="decide-btn full-width" id="btn-save-ai-recipe" style="margin-top:12px;">📖 気に入ったのでレシピ帳に保存する</button>`;

  document.getElementById("btn-save-ai-recipe").addEventListener("click", ()=>{
    if(!lastAiRecipe) return;
    const recipe = {
      id: "r_" + Date.now(),
      name: lastAiRecipe.name || "AIが考えた料理",
      category: (lastAiRecipe.category || "主菜").trim(),
      ingredients: ingredientsArr.map(i => ({ name:i.name||"", amount:i.amount||"", unit:i.unit||"" })),
      steps: Array.isArray(lastAiRecipe.steps) ? lastAiRecipe.steps : [],
      processedFree: !!lastAiRecipe.processedFree,
      notes: lastAiRecipe.nutri || ""
    };
    state.recipes.push(recipe);
    save(STORE.recipes, state.recipes);
    toast("レシピ帳に保存しました");
    document.getElementById("btn-save-ai-recipe").disabled = true;
    document.getElementById("btn-save-ai-recipe").textContent = "✓ 保存しました";
  });
}

/* ---------------- 初期化 ---------------- */
renderHome();

if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  });
}
