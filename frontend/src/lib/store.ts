import { create } from "zustand";
import type {
  ParsedPaper,
  PreReadingAnalysis,
  QAItem,
  DerivationExercise,
  Assumption,
  SearchResult,
  Note,
} from "./api";

interface AppStore {
  paper: ParsedPaper | null;
  setPaper: (p: ParsedPaper | null) => void;

  loading: boolean;
  setLoading: (l: boolean) => void;

  activeTab: string;
  setActiveTab: (t: string) => void;

  panelVisible: boolean;
  setPanelVisible: (v: boolean) => void;
  togglePanel: () => void;

  preReading: PreReadingAnalysis | null;
  setPreReading: (p: PreReadingAnalysis | null) => void;
  preReadingLoading: boolean;
  setPreReadingLoading: (l: boolean) => void;

  questions: string[];
  addQuestion: (q: string) => void;
  removeQuestion: (idx: number) => void;
  clearQuestions: () => void;
  qaResults: QAItem[];
  setQAResults: (items: QAItem[]) => void;
  qaLoading: boolean;
  setQALoading: (l: boolean) => void;

  exercise: DerivationExercise | null;
  setExercise: (e: DerivationExercise | null) => void;
  exerciseLoading: boolean;
  setExerciseLoading: (l: boolean) => void;

  assumptions: Assumption[];
  setAssumptions: (a: Assumption[]) => void;
  assumptionsLoading: boolean;
  setAssumptionsLoading: (l: boolean) => void;

  searchResults: SearchResult[];
  setSearchResults: (r: SearchResult[]) => void;
  searchLoading: boolean;
  setSearchLoading: (l: boolean) => void;

  notes: Note[];
  setNotes: (n: Note[]) => void;
  addNote: (n: Note) => void;
  updateNote: (id: string, text: string) => void;
  removeNote: (id: string) => void;
}

export const useStore = create<AppStore>((set) => ({
  paper: null,
  setPaper: (p) => set({ paper: p }),

  loading: false,
  setLoading: (l) => set({ loading: l }),

  activeTab: "preread",
  setActiveTab: (t) => set({ activeTab: t }),

  panelVisible: true,
  setPanelVisible: (v) => set({ panelVisible: v }),
  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),

  preReading: null,
  setPreReading: (p) => set({ preReading: p }),
  preReadingLoading: false,
  setPreReadingLoading: (l) => set({ preReadingLoading: l }),

  questions: [],
  addQuestion: (q) => set((s) => ({ questions: [...s.questions, q] })),
  removeQuestion: (idx) =>
    set((s) => ({ questions: s.questions.filter((_, i) => i !== idx) })),
  clearQuestions: () => set({ questions: [] }),
  qaResults: [],
  setQAResults: (items) => set({ qaResults: items }),
  qaLoading: false,
  setQALoading: (l) => set({ qaLoading: l }),

  exercise: null,
  setExercise: (e) => set({ exercise: e }),
  exerciseLoading: false,
  setExerciseLoading: (l) => set({ exerciseLoading: l }),

  assumptions: [],
  setAssumptions: (a) => set({ assumptions: a }),
  assumptionsLoading: false,
  setAssumptionsLoading: (l) => set({ assumptionsLoading: l }),

  searchResults: [],
  setSearchResults: (r) => set({ searchResults: r }),
  searchLoading: false,
  setSearchLoading: (l) => set({ searchLoading: l }),

  notes: [],
  setNotes: (n) => set({ notes: n }),
  addNote: (n) => set((s) => ({ notes: [...s.notes, n] })),
  updateNote: (id, text) =>
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? { ...n, text } : n)),
    })),
  removeNote: (id) =>
    set((s) => ({ notes: s.notes.filter((n) => n.id !== id) })),
}));
