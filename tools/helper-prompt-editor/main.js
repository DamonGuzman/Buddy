import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

const editorElement = document.querySelector('#editor');
const saveButton = document.querySelector('#save');
const reloadButton = document.querySelector('#reload');
const statusElement = document.querySelector('#status');
const toolbar = document.querySelector('#toolbar');
const blockStyle = document.querySelector('#block-style');

const suppliedToken = new URLSearchParams(window.location.search).get('token');
if (suppliedToken) sessionStorage.setItem('buddy-helper-prompt-token', suppliedToken);
const sessionToken = sessionStorage.getItem('buddy-helper-prompt-token');
window.history.replaceState(null, '', window.location.pathname);

let editor;
let revision = '';
let savedMarkdown = '';
let saving = false;

function setStatus(message, tone = 'neutral') {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
}

function currentMarkdown() {
  return editor?.getMarkdown().trim() ?? '';
}

function isDirty() {
  return Boolean(editor) && currentMarkdown() !== savedMarkdown;
}

function refreshControls() {
  const ready = Boolean(editor) && !saving;
  saveButton.disabled = !ready || !isDirty();
  reloadButton.disabled = !ready;
  for (const control of toolbar.querySelectorAll('button, select')) control.disabled = !ready;
  if (!editor) return;

  const activeCommands = {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    strike: editor.isActive('strike'),
    code: editor.isActive('code'),
    link: editor.isActive('link'),
    'bullet-list': editor.isActive('bulletList'),
    'ordered-list': editor.isActive('orderedList'),
    blockquote: editor.isActive('blockquote'),
    'code-block': editor.isActive('codeBlock'),
  };
  for (const button of toolbar.querySelectorAll('button[data-command]')) {
    button.classList.toggle('is-active', activeCommands[button.dataset.command] === true);
  }

  blockStyle.value = editor.isActive('heading', { level: 1 })
    ? 'heading-1'
    : editor.isActive('heading', { level: 2 })
      ? 'heading-2'
      : editor.isActive('heading', { level: 3 })
        ? 'heading-3'
        : 'paragraph';
}

async function api(method, body) {
  if (!sessionToken) throw new Error('open the editor from npm run prompt:edit');
  const response = await fetch('/api/prompt', {
    method,
    headers: {
      'content-type': 'application/json',
      'x-buddy-prompt-token': sessionToken,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `request failed (${response.status})`);
  return payload;
}

function replaceDocument(markdown) {
  if (!editor) {
    editor = new Editor({
      element: editorElement,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          link: { autolink: true, defaultProtocol: 'https', openOnClick: false },
        }),
        Markdown.configure({ indentation: { style: 'space', size: 2 } }),
      ],
      content: markdown,
      contentType: 'markdown',
      editorProps: {
        attributes: { 'aria-label': 'Helper Buddy system prompt', spellcheck: 'true' },
      },
      onUpdate: () => {
        setStatus(isDirty() ? 'Unsaved changes' : 'Saved', isDirty() ? 'dirty' : 'saved');
        refreshControls();
      },
      onSelectionUpdate: refreshControls,
      onTransaction: refreshControls,
    });
    return;
  }
  editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
}

async function load() {
  setStatus('Loading…');
  const payload = await api('GET');
  replaceDocument(payload.markdown);
  revision = payload.revision;
  savedMarkdown = currentMarkdown();
  setStatus('Saved', 'saved');
  refreshControls();
}

async function save() {
  if (!editor || saving || !isDirty()) return;
  saving = true;
  setStatus('Saving…');
  refreshControls();
  try {
    const payload = await api('PUT', { markdown: currentMarkdown(), revision });
    revision = payload.revision;
    replaceDocument(payload.markdown);
    savedMarkdown = currentMarkdown();
    setStatus('Saved', 'saved');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Save failed', 'error');
  } finally {
    saving = false;
    refreshControls();
  }
}

async function reload() {
  if (isDirty() && !window.confirm('Discard your unsaved prompt edits?')) return;
  try {
    await load();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Reload failed', 'error');
  }
}

function editLink() {
  const existing = editor.getAttributes('link').href ?? '';
  const href = window.prompt('Link URL (leave empty to remove)', existing);
  if (href === null) return;
  if (!href.trim()) {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
}

const commands = {
  bold: () => editor.chain().focus().toggleBold().run(),
  italic: () => editor.chain().focus().toggleItalic().run(),
  strike: () => editor.chain().focus().toggleStrike().run(),
  code: () => editor.chain().focus().toggleCode().run(),
  link: editLink,
  'bullet-list': () => editor.chain().focus().toggleBulletList().run(),
  'ordered-list': () => editor.chain().focus().toggleOrderedList().run(),
  blockquote: () => editor.chain().focus().toggleBlockquote().run(),
  'code-block': () => editor.chain().focus().toggleCodeBlock().run(),
  divider: () => editor.chain().focus().setHorizontalRule().run(),
  undo: () => editor.chain().focus().undo().run(),
  redo: () => editor.chain().focus().redo().run(),
};

toolbar.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-command]');
  if (!button || button.disabled) return;
  commands[button.dataset.command]?.();
  refreshControls();
});

blockStyle.addEventListener('change', () => {
  const level = Number(blockStyle.value.replace('heading-', ''));
  if (Number.isInteger(level) && level >= 1 && level <= 3) {
    editor.chain().focus().toggleHeading({ level }).run();
  } else {
    editor.chain().focus().setParagraph().run();
  }
  refreshControls();
});

saveButton.addEventListener('click', save);
reloadButton.addEventListener('click', reload);
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void save();
  }
});
window.addEventListener('beforeunload', (event) => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

load().catch((error) => {
  setStatus(error instanceof Error ? error.message : 'Editor failed to load', 'error');
  editorElement.innerHTML =
    '<p class="fatal">The prompt could not be loaded. Restart this tool from the terminal.</p>';
});
