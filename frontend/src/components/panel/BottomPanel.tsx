"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore } from "@/lib/store";
import { PreReadingPanel } from "../sidebar/PreReadingPanel";
import { QAPanel } from "../sidebar/QAPanel";
import { DerivationPanel } from "../sidebar/DerivationPanel";
import { AssumptionsPanel } from "../sidebar/AssumptionsPanel";
import { SearchPanel } from "../sidebar/SearchPanel";
import { NotesPanel } from "../sidebar/NotesPanel";

interface BottomPanelProps {
  paperId: string;
}

const TAB_STYLE = "text-[12px] h-7 px-3.5 rounded-md font-medium transition-all data-active:bg-foreground data-active:text-background data-active:shadow-sm";

export function BottomPanel({ paperId }: BottomPanelProps) {
  const { activeTab, setActiveTab } = useStore();

  return (
    <Tabs
      value={activeTab}
      onValueChange={setActiveTab}
      className="flex flex-col h-full"
    >
      <div className="shrink-0 flex items-center px-4 pt-2 pb-1.5 border-b bg-accent/30">
        <TabsList className="h-8 gap-1 bg-transparent p-0">
          <TabsTrigger value="preread" className={TAB_STYLE}>Prepare</TabsTrigger>
          <TabsTrigger value="derive" className={TAB_STYLE}>Derivations</TabsTrigger>
          <TabsTrigger value="assume" className={TAB_STYLE}>Assumptions</TabsTrigger>
          <TabsTrigger value="qa" className={TAB_STYLE}>Q&A</TabsTrigger>
          <TabsTrigger value="notes" className={TAB_STYLE}>Notes</TabsTrigger>
          <TabsTrigger value="search" className={TAB_STYLE}>Search</TabsTrigger>
        </TabsList>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-5 py-3 max-w-3xl mx-auto">
          <TabsContent value="preread" className="mt-0"><PreReadingPanel paperId={paperId} /></TabsContent>
          <TabsContent value="derive" className="mt-0"><DerivationPanel paperId={paperId} /></TabsContent>
          <TabsContent value="assume" className="mt-0"><AssumptionsPanel paperId={paperId} /></TabsContent>
          <TabsContent value="qa" className="mt-0"><QAPanel paperId={paperId} /></TabsContent>
          <TabsContent value="notes" className="mt-0"><NotesPanel paperId={paperId} /></TabsContent>
          <TabsContent value="search" className="mt-0"><SearchPanel paperId={paperId} /></TabsContent>
        </div>
      </div>
    </Tabs>
  );
}
