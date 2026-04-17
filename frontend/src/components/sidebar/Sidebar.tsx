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
      <TabsList className="grid grid-cols-5 mx-3 mt-3 shrink-0">
        <TabsTrigger value="preread" className="text-xs">
          Prepare
        </TabsTrigger>
        <TabsTrigger value="derive" className="text-xs">
          Derive
        </TabsTrigger>
        <TabsTrigger value="assume" className="text-xs">
          Assume
        </TabsTrigger>
        <TabsTrigger value="qa" className="text-xs">
          Q&A
        </TabsTrigger>
        <TabsTrigger value="search" className="text-xs">
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
