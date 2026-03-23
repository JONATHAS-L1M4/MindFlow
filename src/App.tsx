import React, { useState, useEffect, useRef } from 'react';
import MindMap from './components/MindMap';
import { MindMapNode } from './types';
import { Brain, Code, Eye, Play, Info, Edit2, Download, Upload, HelpCircle, X } from 'lucide-react';

const generateId = () => `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const simpleInitialData: MindMapNode = {
  title: "Nova Ideia",
  content: "Comece a digitar aqui...",
  color: "#6366f1",
  textColor: "#ffffff",
};

const DEFAULT_ROOT_COLOR = simpleInitialData.color ?? "#6366f1";
const DEFAULT_ROOT_TEXT_COLOR = simpleInitialData.textColor ?? "#ffffff";

const normalizeMindMap = (
  node: MindMapNode,
  lockedRootColor = DEFAULT_ROOT_COLOR,
  depth = 0,
  seenIds = new Set<string>()
): MindMapNode => {
  let nextId = node.id?.trim();
  if (!nextId || seenIds.has(nextId)) {
    do {
      nextId = generateId();
    } while (seenIds.has(nextId));
  }
  seenIds.add(nextId);

  const normalized: MindMapNode = {
    ...node,
    id: nextId,
  };

  if (normalized.children) {
    normalized.children = normalized.children.map(child =>
      normalizeMindMap(child, lockedRootColor, depth + 1, seenIds)
    );
  }

  if (depth === 0) {
    normalized.color = lockedRootColor;
    normalized.textColor = normalized.textColor ?? DEFAULT_ROOT_TEXT_COLOR;
    return normalized;
  }

  if (depth >= 2 && normalized.color) {
    delete normalized.color;
  }

  return normalized;
};

export default function App() {
  const [mindMapData, setMindMapData] = useState<MindMapNode>(() => {
    const cached = localStorage.getItem('mindflow-data');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return normalizeMindMap(parsed, parsed.color ?? DEFAULT_ROOT_COLOR);
      } catch (e) {
        console.error('Error parsing cached data', e);
      }
    }
    return normalizeMindMap(simpleInitialData, DEFAULT_ROOT_COLOR);
  });

  const [jsonInput, setJsonInput] = useState(() => JSON.stringify(mindMapData, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'viewer' | 'edit-map' | 'editor'>('viewer');
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem('mindflow-data', JSON.stringify(mindMapData));
  }, [mindMapData]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    };
    
    updateTheme(mediaQuery);
    
    const listener = (e: MediaQueryListEvent) => updateTheme(e);
    mediaQuery.addEventListener('change', listener);
    
    return () => mediaQuery.removeEventListener('change', listener);
  }, []);

  const handleUpdate = () => {
    try {
      const parsed = JSON.parse(jsonInput);
      const parsedWithIds = normalizeMindMap(parsed, parsed.color ?? DEFAULT_ROOT_COLOR);
      setMindMapData(parsedWithIds);
      setJsonInput(JSON.stringify(parsedWithIds, null, 2));
      setError(null);
      setActiveTab('viewer');
    } catch (e) {
      setError('JSON inválido. Verifique a estrutura.');
    }
  };

  const handleMapChange = (newData: MindMapNode) => {
    const normalizedData = normalizeMindMap(newData, newData.color ?? DEFAULT_ROOT_COLOR);
    setMindMapData(normalizedData);
    setJsonInput(JSON.stringify(normalizedData, null, 2));
  };

  const handleExport = () => {
    const dataStr = JSON.stringify(mindMapData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mindmap.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const parsed = JSON.parse(content);
        const parsedWithIds = normalizeMindMap(parsed, parsed.color ?? DEFAULT_ROOT_COLOR);
        setMindMapData(parsedWithIds);
        setJsonInput(JSON.stringify(parsedWithIds, null, 2));
        setError(null);
      } catch (err) {
        alert("Erro ao importar: Arquivo JSON inválido.");
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="h-screen w-full flex flex-col bg-zinc-50 dark:bg-zinc-950 font-sans overflow-hidden">
      <main className="flex-1 relative overflow-hidden flex">
        {/* Floating Header */}
        <div className="absolute top-6 left-6 z-40 flex items-center gap-2.5 pointer-events-none">
          <div className="bg-indigo-600 p-1.5 rounded-lg shadow-md shadow-indigo-200 dark:shadow-none pointer-events-auto">
            <Brain size={18} className="text-white" />
          </div>
          <div className="pointer-events-auto">
            <h1 className="text-lg font-bold text-zinc-900 dark:text-white leading-tight drop-shadow-sm">MindFlow</h1>
          </div>
        </div>

        {/* Floating Controls */}
        <div className="absolute top-6 right-6 z-40 flex items-center gap-2 pointer-events-auto">
          <div className="flex items-center bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl p-1 shadow-sm mr-2">
            <button
              onClick={() => setActiveTab('viewer')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'viewer' 
                  ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm' 
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              <Eye size={16} />
              Visualizar
            </button>
            <button
              onClick={() => setActiveTab('edit-map')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'edit-map' 
                  ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm' 
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              <Edit2 size={16} />
              Editar
            </button>
          </div>

          <input 
            type="file" 
            accept=".json" 
            ref={fileInputRef} 
            onChange={handleImport} 
            className="hidden" 
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center justify-center w-10 h-10 rounded-xl text-zinc-600 dark:text-zinc-400 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-all"
            title="Importar JSON"
          >
            <Upload size={18} />
          </button>
          <button
            onClick={handleExport}
            className="flex items-center justify-center w-10 h-10 rounded-xl text-zinc-600 dark:text-zinc-400 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-all"
            title="Exportar JSON"
          >
            <Download size={18} />
          </button>
          <div className="w-px h-6 bg-zinc-200 dark:bg-zinc-700 mx-1"></div>
          <button
            onClick={() => setIsHelpOpen(true)}
            className="flex items-center justify-center w-10 h-10 rounded-xl text-zinc-600 dark:text-zinc-400 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-all"
            title="Ajuda"
          >
            <HelpCircle size={18} />
          </button>
          <button
            onClick={() => setActiveTab(activeTab === 'editor' ? 'viewer' : 'editor')}
            className={`flex items-center gap-2 px-4 py-2 h-10 rounded-xl text-sm font-medium transition-all duration-200 shadow-sm border ${
              activeTab === 'editor' 
                ? 'bg-indigo-600 text-white border-indigo-600' 
                : 'bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700'
            }`}
          >
            <Code size={16} />
            {activeTab === 'editor' ? 'Fechar JSON' : 'Editor JSON'}
          </button>
        </div>

        {/* MindMap View */}
        <div className="flex-1 h-full relative">
          <MindMap 
            data={mindMapData} 
            onChange={handleMapChange} 
            isReadOnly={activeTab === 'viewer'} 
          />
        </div>

        {/* Editor View */}
        <div 
          className={`h-full bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md z-30 transition-all duration-500 ease-in-out flex-shrink-0 overflow-hidden border-zinc-200 dark:border-zinc-800 ${
            activeTab === 'editor' ? 'w-1/2 border-l shadow-2xl' : 'w-0 border-l-0'
          }`}
        >
          <div className="h-full flex flex-col p-6 pt-24 gap-4 w-[50vw]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                <Info size={16} />
                <span className="text-sm truncate">Edite o JSON para atualizar o mapa.</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={handleUpdate}
                  className="flex items-center gap-2 bg-indigo-600 text-white px-6 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 dark:shadow-none"
                >
                  <Play size={16} />
                  Atualizar Mapa
                </button>
              </div>
            </div>
            
            <div className="flex-1 relative">
              <textarea
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                className="w-full h-full p-6 font-mono text-sm bg-zinc-50 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-800 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-none transition-colors duration-300 shadow-inner"
                spellCheck={false}
              />
              {error && (
                <div className="absolute bottom-4 left-4 right-4 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/50 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2">
                  <Info size={16} />
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Help Modal */}
      {isHelpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-zinc-200 dark:border-zinc-800">
              <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Como criar o JSON manualmente</h2>
              <button onClick={() => setIsHelpOpen(false)} className="p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-colors">
                <X size={20} />
              </button>
            </div>
            <div className="p-6 overflow-y-auto max-h-[70vh] text-zinc-700 dark:text-zinc-300 space-y-4">
              <p>O mapa mental é construído usando uma estrutura de árvore em JSON. Cada item é chamado de "nó" (node).</p>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50 mt-4">Propriedades de um Nó:</h3>
              <ul className="list-disc pl-5 space-y-2">
                <li><code className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-indigo-600 dark:text-indigo-400">title</code> (Obrigatório): O texto que aparecerá no nó.</li>
                <li><code className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-indigo-600 dark:text-indigo-400">content</code> (Opcional): Texto descritivo em formato Markdown.</li>
                <li><code className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-indigo-600 dark:text-indigo-400">children</code> (Opcional): Uma lista (array) de outros nós que ficarão abaixo deste.</li>
                <li><code className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-indigo-600 dark:text-indigo-400">color</code> (Opcional): Cor de fundo do nó (ex: "#ff0000" ou "red").</li>
                <li><code className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-indigo-600 dark:text-indigo-400">textColor</code> (Opcional): Cor do texto do nó (ex: "#ffffff").</li>
              </ul>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50 mt-4">Exemplo Básico:</h3>
              <pre className="bg-zinc-100 dark:bg-zinc-950 p-4 rounded-xl overflow-x-auto text-sm font-mono border border-zinc-200 dark:border-zinc-800">
{`{
  "title": "Ideia Principal",
  "content": "Esta é a ideia **principal** do projeto.",
  "color": "#6366f1",
  "textColor": "#ffffff",
  "children": [
    {
      "title": "Sub-ideia 1",
      "content": "Detalhes em *itálico* ou com [links](https://google.com)"
    },
    {
      "title": "Sub-ideia 2",
      "children": [
        { "title": "Detalhe A" }
      ]
    }
  ]
}`}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
