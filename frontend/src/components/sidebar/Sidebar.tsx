"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useStore } from "@/lib/store";
import { PreReadingPanel } from "./PreReadingPanel";
import { QAPanel } from "./QAPanel";
import { DerivationPanel } from "./DerivationPanel";
import { AssumptionsPanel } from "./AssumptionsPanel";
import { SearchPanel } from "./SearchPanel";

interface SidebarProps {
  paperId: string;
}

export function Sidebar({ paperId }: SidebarProps) {
  const { activeTab, setActiveTab } = useStore();

  return (
    <Tabs
      value={activeTab}
      onValueChange={setActiveTab}
      className="flex flex-col h-full"
    >
      <TabsList className="mx-3 mt-3 grid h-10 shrink-0 grid-cols-5 gap-0.5 rounded-xl border border-border/55 bg-muted/45 p-[3px] shadow-[var(--shadow-xs)] backdrop-blur-sm">
        <TabsTrigger
          value="preread"
          className="min-w-0 px-1 py-1 text-[11px] font-medium tracking-tight data-active:font-semibold motion-safe:transition-[color,box-shadow] motion-safe:duration-150"
        >
          Prepare
        </TabsTrigger>
        <TabsTrigger
          value="derive"
          className="min-w-0 px-1 py-1 text-[11px] font-medium tracking-tight data-active:font-semibold motion-safe:transition-[color,box-shadow] motion-safe:duration-150"
        >
          Derive
        </TabsTrigger>
        <TabsTrigger
          value="assume"
          className="min-w-0 px-1 py-1 text-[11px] font-medium tracking-tight data-active:font-semibold motion-safe:transition-[color,box-shadow] motion-safe:duration-150"
        >
          Assume
        </TabsTrigger>
        <TabsTrigger
          value="qa"
          className="min-w-0 px-1 py-1 text-[11px] font-medium tracking-tight data-active:font-semibold motion-safe:transition-[color,box-shadow] motion-safe:duration-150"
        >
          Q&A
        </TabsTrigger>
        <TabsTrigger
          value="search"
          className="min-w-0 px-1 py-1 text-[11px] font-medium tracking-tight data-active:font-semibold motion-safe:transition-[color,box-shadow] motion-safe:duration-150"
        >
          Search
        </TabsTrigger>
      </TabsList>

      <ScrollArea className="flex-1 mt-2">
        <div className="px-3 pb-4">
          <TabsContent value="preread" className="mt-0">
            <PreReadingPanel paperId={paperId} />
          </TabsContent>
          <TabsContent value="derive" className="mt-0">
            <DerivationPanel paperId={paperId} />
          </TabsContent>
          <TabsContent value="assume" className="mt-0">
            <AssumptionsPanel paperId={paperId} />
          </TabsContent>
          <TabsContent value="qa" className="mt-0">
            <QAPanel paperId={paperId} />
          </TabsContent>
          <TabsContent value="search" className="mt-0">
            <SearchPanel paperId={paperId} />
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  );
}
