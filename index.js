// ============================================================
// State
// ============================================================
let recognition = null;
let isRecording = false;
let currentBackend = 'nano';
let nanoSession = null;
let lastResponse = '';

// ============================================================
// DOM refs
// ============================================================
const micBtn = document.getElementById('micBtn');
const transcriptBox = document.getElementById('transcriptBox');
const responseBox = document.getElementById('responseBox');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const stopSpeakBtn = document.getElementById('stopSpeakBtn');
const respeakBtn = document.getElementById('respeakBtn');
const ttsVoiceSel = document.getElementById('ttsVoice');
const ttsRateInput = document.getElementById('ttsRate');
const ttsPitchInput = document.getElementById('ttsPitch');
const ttsRateVal = document.getElementById('ttsRateVal');
const ttsPitchVal = document.getElementById('ttsPitchVal');
const errMsg = document.getElementById('errMsg');
const apiKeyInput = document.getElementById('apiKey');

// ============================================================
// Debug log helper
// ============================================================
const debugLog = document.getElementById('debugLog');
function dbg(msg) {
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    const line = `[${ts}] ${msg}\n`;
    console.log('[VoiceAI]', msg);
    debugLog.textContent += line;
    debugLog.scrollTop = debugLog.scrollHeight;
}
function clearDebug() { debugLog.textContent = ''; }

// ============================================================
// Status helper
// ============================================================
function setStatus(state, text) {
    statusDot.className = 'dot ' + state;
    statusText.textContent = text;
}

function showErr(msg) {
    errMsg.textContent = msg;
    setTimeout(() => { errMsg.textContent = ''; }, 8000);
}

// ============================================================
// TTS voices
// ============================================================
function populateVoices() {
    const voices = speechSynthesis.getVoices();
    ttsVoiceSel.innerHTML = '';
    voices.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${v.name} (${v.lang})`;
        if (v.lang.startsWith('ja')) opt.selected = true;
        ttsVoiceSel.appendChild(opt);
    });
}

speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();

ttsRateInput.addEventListener('input', () => { ttsRateVal.textContent = ttsRateInput.value; });
ttsPitchInput.addEventListener('input', () => { ttsPitchVal.textContent = ttsPitchInput.value; });

function speak(text) {
    speechSynthesis.cancel();
    if (!text) return;
    const utter = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const idx = parseInt(ttsVoiceSel.value, 10);
    if (voices[idx]) utter.voice = voices[idx];
    utter.rate = parseFloat(ttsRateInput.value);
    utter.pitch = parseFloat(ttsPitchInput.value);

    utter.onstart = () => setStatus('speaking', '読み上げ中...');
    utter.onend = () => setStatus('ready', '準備完了');
    utter.onerror = (e) => { setStatus('ready', '準備完了'); showErr('TTS エラー: ' + e.error); };

    speechSynthesis.speak(utter);
}

stopSpeakBtn.addEventListener('click', () => { speechSynthesis.cancel(); setStatus('ready', '準備完了'); });
respeakBtn.addEventListener('click', () => { if (lastResponse) speak(lastResponse); });

// ============================================================
// Backend toggle
// ============================================================
function switchBackend(backend) {
    currentBackend = backend;
    document.getElementById('tabNano').classList.toggle('active', backend === 'nano');
    document.getElementById('tabApi').classList.toggle('active', backend === 'api');
    document.getElementById('nanoPanel').style.display = backend === 'nano' ? '' : 'none';
    document.getElementById('apiPanel').style.display = backend === 'api' ? '' : 'none';
    nanoSession = null; // reset session on switch
}

// ============================================================
// Chrome Built-in AI (Gemini Nano) — Prompt API
// ============================================================
// withTimeout: Promise にタイムアウトを付ける
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`タイムアウト (${ms / 1000}s): ${label}`)), ms);
        promise.then(v => { clearTimeout(t); resolve(v); },
            e => { clearTimeout(t); reject(e); });
    });
}

async function initNanoSession() {
    if (nanoSession) return nanoSession;

    const sysPrompt = document.getElementById('systemPrompt').value.trim();
    const createOpts = sysPrompt ? { systemPrompt: sysPrompt } : {};

    dbg('window.LanguageModel: ' + typeof window.LanguageModel);
    dbg('window.ai: ' + typeof window.ai);
    dbg('window.ai?.languageModel: ' + typeof window.ai?.languageModel);

    // --- 新 API: window.LanguageModel ---
    if (typeof window.LanguageModel !== 'undefined') {
        let avail = null;
        if (typeof window.LanguageModel.availability === 'function') {
            avail = await window.LanguageModel.availability().catch(e => { dbg('availability() error: ' + e); return null; });
            dbg('LanguageModel.availability() = ' + avail);
        } else {
            dbg('availability() なし — スキップ');
        }

        if (avail === 'unavailable') {
            throw new Error('Gemini Nano が利用不可 (unavailable)。chrome://flags を確認してください。');
        }

        // 言語ヒントを付加（警告抑制 + 品質向上）
        const langHints = { expectedInputLanguages: ['ja', 'en'], expectedOutputLanguages: ['ja'] };
        const createOptsWithLang = { ...createOpts, ...langHints };

        if (avail === 'downloading') {
            dbg('Gemini Nano ダウンロード中... create() でダウンロード完了を待機します（数分かかる場合があります）');
            setStatus('thinking', 'Gemini Nano ダウンロード中...');
        }

        dbg('LanguageModel.create() 呼び出し中...');
        nanoSession = await withTimeout(
            window.LanguageModel.create({
                ...createOptsWithLang,
                monitor(m) {
                    m.addEventListener('downloadprogress', (e) => {
                        const pct = e.total ? Math.round(e.loaded / e.total * 100) : '?';
                        dbg(`ダウンロード進捗: ${pct}% (${e.loaded}/${e.total})`);
                        setStatus('thinking', `Nano ダウンロード中 ${pct}%`);
                    });
                }
            }),
            600000, // 最大10分待機
            'LanguageModel.create'
        );
        dbg('セッション作成完了 (新API)');
        return nanoSession;
    }

    // --- 旧 API: window.ai.languageModel ---
    const lm = window.ai?.languageModel;
    if (lm) {
        if (typeof lm.capabilities === 'function') {
            const caps = await lm.capabilities().catch(e => { dbg('capabilities() error: ' + e); return {}; });
            dbg('capabilities.available = ' + caps.available);
            if (caps.available === 'no') {
                throw new Error('Gemini Nano がダウンロードされていないか、利用不可です。');
            }
        } else {
            dbg('capabilities() なし — スキップ');
        }

        dbg('ai.languageModel.create() 呼び出し中...');
        nanoSession = await withTimeout(lm.create(createOpts), 30000, 'lm.create');
        dbg('セッション作成完了 (旧API)');
        return nanoSession;
    }

    throw new Error('Chrome Built-in AI が利用できません。chrome://flags を確認してください。');
}

async function askNano(text) {
    const session = await initNanoSession();
    dbg('prompt 送信: ' + text.slice(0, 60));

    // まず promptStreaming を試みる
    if (typeof session.promptStreaming === 'function') {
        dbg('promptStreaming() 使用');
        try {
            const stream = await withTimeout(
                Promise.resolve(session.promptStreaming(text)), 60000, 'promptStreaming start'
            );
            let result = '';
            let prev = '';
            for await (const chunk of stream) {
                // chunk が累積テキストの場合と差分の場合どちらも対応
                if (typeof chunk === 'string') {
                    if (chunk.length >= prev.length) {
                        result = chunk;
                    } else {
                        result += chunk;
                    }
                    prev = chunk.length >= prev.length ? chunk : prev + chunk;
                }
                showResponse(result, true);
            }
            dbg('streaming 完了: ' + result.length + ' 文字');
            return result;
        } catch (e) {
            dbg('promptStreaming 失敗、prompt() にフォールバック: ' + e.message);
        }
    }

    // フォールバック: 通常の prompt()
    if (typeof session.prompt === 'function') {
        dbg('prompt() 使用');
        showResponse('生成中...', true);
        const result = await withTimeout(session.prompt(text), 60000, 'prompt()');
        dbg('prompt() 完了: ' + result.length + ' 文字');
        return result;
    }

    throw new Error('session.prompt / promptStreaming が見つかりません。利用可能なメソッド: ' + Object.keys(session).join(', '));
}

// ============================================================
// Gemini REST API
// ============================================================
async function askGeminiApi(text) {
    const key = apiKeyInput.value.trim();
    if (!key) throw new Error('Gemini API キーを入力してください。');

    const model = document.getElementById('modelSelect').value;
    const sysPrompt = document.getElementById('systemPrompt').value.trim();

    const body = {
        system_instruction: sysPrompt ? { parts: [{ text: sysPrompt }] } : undefined,
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 512 }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '(空の回答)';
}

// ============================================================
// Unified ask
// ============================================================
async function ask(text) {
    setStatus('thinking', 'AIが考え中...');
    micBtn.disabled = true;

    try {
        let answer;
        if (currentBackend === 'nano') {
            answer = await askNano(text);
        } else {
            answer = await askGeminiApi(text);
        }

        lastResponse = answer;
        showResponse(answer, false);
        speak(answer);
    } catch (e) {
        showErr('AI エラー: ' + e.message);
        setStatus('ready', '準備完了');
    } finally {
        micBtn.disabled = false;
    }
}

function showResponse(text, streaming) {
    responseBox.classList.remove('placeholder');
    responseBox.textContent = text + (streaming ? '▊' : '');
}

// ============================================================
// Speech Recognition (STT)
// ============================================================
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
    micBtn.disabled = true;
    setStatus('', '⚠️ このブラウザは音声認識に対応していません (Chrome 推奨)');
} else {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
        isRecording = true;
        micBtn.classList.add('recording');
        micBtn.textContent = '⏹';
        setStatus('recording', '聞いています...');
    };

    recognition.onresult = (e) => {
        let interim = '';
        let final = '';
        for (const res of e.results) {
            if (res.isFinal) final += res[0].transcript;
            else interim += res[0].transcript;
        }
        transcriptBox.classList.remove('placeholder');
        transcriptBox.textContent = (final || interim) + (interim ? ' ...' : '');
        if (final) recognition._finalText = final;
    };

    recognition.onend = () => {
        isRecording = false;
        micBtn.classList.remove('recording');
        micBtn.textContent = '🎤';
        setStatus('ready', '準備完了');

        const text = (recognition._finalText || '').trim();
        recognition._finalText = '';
        if (text) ask(text);
    };

    recognition.onerror = (e) => {
        isRecording = false;
        micBtn.classList.remove('recording');
        micBtn.textContent = '🎤';
        if (e.error === 'not-allowed' || e.error === 'permission-denied') {
            setStatus('', '⚠️ マイクへのアクセスが拒否されています');
            showErr('マイクの使用が許可されていません。アドレスバー左のカメラ/マイクアイコンをクリックして「許可」に変更し、ページを再読み込みしてください。');
        } else if (e.error === 'no-speech') {
            setStatus('ready', '準備完了');
            showErr('音声が検出されませんでした。もう一度試してください。');
        } else if (e.error !== 'aborted') {
            showErr('音声認識エラー: ' + e.error);
            setStatus('ready', '準備完了');
        } else {
            setStatus('ready', '準備完了');
        }
    };

    micBtn.addEventListener('click', () => {
        if (isRecording) {
            recognition.stop();
            return;
        }
        // recognition.start() はユーザージェスチャーの同期コンテキストで呼ぶ必要がある
        // (await を挟むと not-allowed になる)
        recognition.lang = document.getElementById('sttLang').value;
        speechSynthesis.cancel();
        recognition.start();
    });

    setStatus('ready', '準備完了 — マイクボタンを押して話してください');
}