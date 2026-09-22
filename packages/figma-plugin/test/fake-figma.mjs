/**
 * Implementation en memoire de la partie de l'API Figma qu'utilise le plugin.
 *
 * Raison d'etre : la reconciliation idempotente est le coeur du systeme — c'est
 * elle qui garantit qu'une seconde synchronisation met a jour au lieu de
 * dupliquer, donc que les commentaires et le travail du developpeur survivent.
 * On ne peut pas la laisser sans test sous pretexte que Figma n'est pas
 * scriptable hors de son application.
 *
 * Ce faux moteur reproduit les regles qui comptent, y compris celles qui levent
 * une exception dans le vrai Figma : « remplir » exige un parent en auto-layout,
 * « ajuster » exige un auto-layout propre, et un texte exige une police chargee.
 */

let nextId = 1;

class FakeNode {
  constructor(type) {
    this.id = `${type}:${nextId++}`;
    this.type = type;
    this.name = type;
    this.parent = null;
    this.visible = true;
    this.opacity = 1;
    this.width = 100;
    this.height = 100;
    this.x = 0;
    this.y = 0;
    this.fills = [];
    this.strokes = [];
    this.effects = [];
    this.pluginData = new Map();
    this.removed = false;
  }

  setPluginData(key, value) {
    this.pluginData.set(key, value);
  }

  getPluginData(key) {
    return this.pluginData.get(key) ?? '';
  }

  resize(w, h) {
    this.width = w;
    this.height = h;
  }

  resizeWithoutConstraints(w, h) {
    this.resize(w, h);
  }

  remove() {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    this.removed = true;
    this.parent = null;
  }
}

class FakeContainer extends FakeNode {
  constructor(type) {
    super(type);
    this.children = [];
    this.layoutMode = 'NONE';
    this.layoutWrap = 'NO_WRAP';
    this.paddingTop = 0;
    this.paddingRight = 0;
    this.paddingBottom = 0;
    this.paddingLeft = 0;
    this.itemSpacing = 0;
    this.counterAxisSpacing = 0;
    this.primaryAxisAlignItems = 'MIN';
    this.counterAxisAlignItems = 'MIN';
    this.clipsContent = false;
    this.maxWidth = null;
    this.minWidth = null;
    this.maxHeight = null;
    this.minHeight = null;
    this.layoutPositioning = 'AUTO';
    this.constraints = { horizontal: 'MIN', vertical: 'MIN' };
    this.topLeftRadius = 0;
    this.topRightRadius = 0;
    this.bottomRightRadius = 0;
    this.bottomLeftRadius = 0;
    this.strokeWeight = 0;
    this.strokeAlign = 'INSIDE';
    this.strokeTopWeight = 0;
    this.strokeRightWeight = 0;
    this.strokeBottomWeight = 0;
    this.strokeLeftWeight = 0;
    this.dashPattern = [];
    this.blendMode = 'NORMAL';
    this._sizingH = 'FIXED';
    this._sizingV = 'FIXED';
  }

  appendChild(node) {
    if (node.parent) {
      const index = node.parent.children.indexOf(node);
      if (index >= 0) node.parent.children.splice(index, 1);
    }
    node.parent = this;
    this.children.push(node);
  }

  insertChild(index, node) {
    if (node.parent) {
      const current = node.parent.children.indexOf(node);
      if (current >= 0) node.parent.children.splice(current, 1);
    }
    node.parent = this;
    this.children.splice(Math.min(index, this.children.length), 0, node);
  }

  setBoundVariable() {
    /* liaison acceptee sans effet dans le faux moteur */
  }

  async setEffectStyleIdAsync() {
    /* accepte */
  }

  // Les regles de dimensionnement de Figma, reproduites fidelement : ce sont
  // elles qui font echouer une synchronisation mal ordonnee.
  get layoutSizingHorizontal() {
    return this._sizingH;
  }

  set layoutSizingHorizontal(value) {
    assertSizing(this, value, 'horizontal');
    this._sizingH = value;
  }

  get layoutSizingVertical() {
    return this._sizingV;
  }

  set layoutSizingVertical(value) {
    assertSizing(this, value, 'vertical');
    this._sizingV = value;
  }
}

function assertSizing(node, value, axis) {
  if (value === 'FILL') {
    const parent = node.parent;
    if (!parent || !('layoutMode' in parent) || parent.layoutMode === 'NONE') {
      throw new Error(
        `layoutSizing${axis === 'horizontal' ? 'Horizontal' : 'Vertical'} ne peut valoir FILL que dans un parent en auto-layout`,
      );
    }
    if (node.layoutPositioning === 'ABSOLUTE') {
      throw new Error('FILL impossible sur un enfant en position absolue');
    }
  }
  if (value === 'HUG' && node.type !== 'TEXT') {
    if (!('layoutMode' in node) || node.layoutMode === 'NONE') {
      throw new Error('HUG exige que le noeud ait lui-meme un auto-layout');
    }
  }
}

class FakeText extends FakeNode {
  constructor() {
    super('TEXT');
    this._fontName = null;
    this._characters = '';
    this.fontSize = 16;
    this.lineHeight = { unit: 'AUTO' };
    this.letterSpacing = { unit: 'PIXELS', value: 0 };
    this.textCase = 'ORIGINAL';
    this.textDecoration = 'NONE';
    this.paragraphSpacing = 0;
    this.textAlignHorizontal = 'LEFT';
    this.textAlignVertical = 'TOP';
    this.textAutoResize = 'NONE';
    this.textTruncation = 'DISABLED';
    this.layoutPositioning = 'AUTO';
    this.constraints = { horizontal: 'MIN', vertical: 'MIN' };
    this.blendMode = 'NORMAL';
    this._sizingH = 'FIXED';
    this._sizingV = 'FIXED';
    this.hyperlinks = [];
  }

  get fontName() {
    return this._fontName;
  }

  set fontName(font) {
    // Regle reelle de Figma : ecrire dans une police non chargee leve une
    // exception. C'est le premier piege d'un plugin qui touche au texte.
    if (!loadedFonts.has(`${font.family}|${font.style}`)) {
      throw new Error(`Police non chargee : ${font.family} ${font.style}`);
    }
    this._fontName = font;
  }

  get characters() {
    return this._characters;
  }

  set characters(value) {
    if (!this._fontName) throw new Error('Police non definie avant ecriture du texte');
    this._characters = value;
  }

  async setTextStyleIdAsync(id) {
    this.textStyleId = id;
  }

  setRangeHyperlink(start, end, link) {
    this.hyperlinks.push({ start, end, link });
  }

  get layoutSizingHorizontal() {
    return this._sizingH;
  }

  set layoutSizingHorizontal(value) {
    assertSizing(this, value, 'horizontal');
    this._sizingH = value;
  }

  get layoutSizingVertical() {
    return this._sizingV;
  }

  set layoutSizingVertical(value) {
    assertSizing(this, value, 'vertical');
    this._sizingV = value;
  }
}

class FakePage extends FakeContainer {
  constructor(name) {
    super('PAGE');
    this.name = name;
    this.loaded = false;
  }

  async loadAsync() {
    this.loaded = true;
  }
}

const loadedFonts = new Set();

/** Polices declarees disponibles dans ce faux Figma. */
const AVAILABLE_FONTS = [
  'Inter|Regular', 'Inter|Medium', 'Inter|Semi Bold', 'Inter|Bold',
  'Source Serif 4|Regular', 'Source Serif 4|Bold',
  'Roboto|Regular', 'Roboto|Bold',
];

export function createFakeFigma(options = {}) {
  const available = options.availableFonts ?? AVAILABLE_FONTS;
  loadedFonts.clear();

  const root = new FakeContainer('DOCUMENT');
  root.name = 'Document de test';
  const firstPage = new FakePage('Page 1');
  root.appendChild(firstPage);

  const notifications = [];
  const collections = [];
  const variables = [];
  const paintStyles = [];
  const textStyles = [];
  const effectStyles = [];
  const createdImages = [];

  const figma = {
    root,
    currentPage: firstPage,
    notify: (message, opts) => notifications.push({ message, ...opts }),
    closePlugin: () => {},
    showUI: () => {},
    ui: { postMessage: () => {}, onmessage: null },
    clientStorage: {
      getAsync: async () => null,
      setAsync: async () => {},
    },

    async loadAllPagesAsync() {
      for (const page of root.children) await page.loadAsync();
    },

    createFrame: () => new FakeContainer('FRAME'),
    createText: () => new FakeText(),
    createEllipse: () => new FakeContainer('ELLIPSE'),
    createPage: () => {
      const page = new FakePage('Page');
      root.appendChild(page);
      return page;
    },
    createNodeFromSvg: () => {
      const frame = new FakeContainer('FRAME');
      frame.name = 'svg';
      return frame;
    },
    createComponentFromNode: (frame) => {
      const component = new FakeContainer('COMPONENT');
      component.name = frame.name;
      component.children = frame.children;
      for (const child of component.children) child.parent = component;
      if (frame.parent) {
        const index = frame.parent.children.indexOf(frame);
        if (index >= 0) frame.parent.children.splice(index, 1, component);
        component.parent = frame.parent;
      }
      return component;
    },
    combineAsVariants: (components, parent) => {
      const set = new FakeContainer('COMPONENT_SET');
      parent.appendChild(set);
      for (const component of components) set.appendChild(component);
      set.defaultVariant = components[0];
      return set;
    },
    createImage: (bytes) => {
      const image = { hash: `image-${createdImages.length + 1}`, bytes };
      createdImages.push(image);
      return image;
    },
    base64Decode: (data) => Uint8Array.from(Buffer.from(data, 'base64')),

    async listAvailableFontsAsync() {
      return available.map((entry) => {
        const [family, style] = entry.split('|');
        return { fontName: { family, style } };
      });
    },
    async loadFontAsync(font) {
      const key = `${font.family}|${font.style}`;
      if (!available.includes(key)) throw new Error(`Police absente : ${key}`);
      loadedFonts.add(key);
    },

    createPaintStyle: () => {
      const style = { id: `paint:${nextId++}`, name: '', paints: [], description: '' };
      paintStyles.push(style);
      return style;
    },
    createTextStyle: () => {
      const style = {
        id: `text:${nextId++}`, name: '', description: '',
        set fontName(font) {
          if (!loadedFonts.has(`${font.family}|${font.style}`)) {
            throw new Error(`Police non chargee : ${font.family} ${font.style}`);
          }
          this._fontName = font;
        },
        get fontName() { return this._fontName; },
      };
      textStyles.push(style);
      return style;
    },
    createEffectStyle: () => {
      const style = { id: `effect:${nextId++}`, name: '', effects: [], description: '' };
      effectStyles.push(style);
      return style;
    },
    async getLocalPaintStylesAsync() { return paintStyles; },
    async getLocalTextStylesAsync() { return textStyles; },
    async getLocalEffectStylesAsync() { return effectStyles; },

    variables: {
      createVariableCollection: (name) => {
        const collection = {
          id: `collection:${nextId++}`,
          name,
          modes: [{ modeId: `mode:${nextId++}`, name: 'Mode 1' }],
          renameMode(modeId, newName) {
            const mode = this.modes.find((m) => m.modeId === modeId);
            if (mode) mode.name = newName;
          },
          addMode(name) {
            const modeId = `mode:${nextId++}`;
            this.modes.push({ modeId, name });
            return modeId;
          },
        };
        collections.push(collection);
        return collection;
      },
      createVariable: (name, collection, resolvedType) => {
        const variable = {
          id: `variable:${nextId++}`,
          name,
          resolvedType,
          description: '',
          variableCollectionId: collection.id,
          valuesByMode: {},
          setValueForMode(modeId, value) {
            this.valuesByMode[modeId] = value;
          },
          remove() {
            const index = variables.indexOf(this);
            if (index >= 0) variables.splice(index, 1);
          },
        };
        variables.push(variable);
        return variable;
      },
      createVariableAlias: (variable) => ({ type: 'VARIABLE_ALIAS', id: variable.id }),
      setBoundVariableForPaint: (paint, field, variable) => ({
        ...paint,
        boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } },
      }),
      async getLocalVariableCollectionsAsync() { return collections; },
      async getLocalVariablesAsync() { return variables; },
    },
  };

  return { figma, state: { notifications, collections, variables, paintStyles, textStyles, effectStyles, createdImages, loadedFonts } };
}

export { FakeContainer, FakeText, FakePage };
