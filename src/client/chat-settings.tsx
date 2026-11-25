import { createPortal } from "react-dom";
import { useState } from "react";
import { SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { useSidebar } from "@/components/ui/sidebar";
import { ChatDetails } from "./chat-details";
import { useChatHost } from "./chat-host";
import { Settings } from "./settings";
import { ThreadNavigation } from "./thread-navigation";

function MobileChatList({ onOpen }: { onOpen: () => void }) {
  const sidebar = useSidebar();
  if (!sidebar.isMobile) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        onOpen();
        sidebar.setOpenMobile(true);
      }}
    >
      Chats
    </Button>
  );
}

// The gear sits in the pane header, while search keeps the chat viewport context.
export function ChatSettings() {
  const host = useChatHost();
  if (host.active === false || host.settingsTarget === null) return null;
  const gear = <ChatSettingsMenu includeDefaults={host.settingsIncludeDefaults ?? false} />;
  return host.settingsTarget ? (
    createPortal(gear, host.settingsTarget)
  ) : (
    <div className="flex shrink-0 justify-end px-2">{gear}</div>
  );
}

function ChatSettingsMenu({ includeDefaults }: { includeDefaults: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        aria-label="Chat settings"
        title="Chat settings"
      >
        <SettingsIcon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-max max-w-[calc(100vw-2rem)] items-start">
        <PopoverTitle className="sr-only">Chat settings</PopoverTitle>
        {includeDefaults && <MobileChatList onOpen={() => setOpen(false)} />}
        <ThreadNavigation />
        <ChatDetails />
        {includeDefaults && (
          <Dialog>
            <DialogTrigger render={<Button variant="ghost" size="sm" />}>
              Model defaults
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Model defaults</DialogTitle>
                <DialogDescription>
                  Application-wide defaults for future conversations and workers.
                </DialogDescription>
              </DialogHeader>
              <Settings />
            </DialogContent>
          </Dialog>
        )}
      </PopoverContent>
    </Popover>
  );
}
