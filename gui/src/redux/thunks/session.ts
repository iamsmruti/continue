import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ChatMessage, Session, SessionMetadata } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { renderChatMessage } from "core/util/messageContent";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  deleteSessionMetadata,
  newSession,
  setAllSessionMetadata,
  setIsSessionMetadataLoading,
  updateSessionMetadata,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

const MAX_TITLE_LENGTH = 100;

// Async session functions live in thunks (because of IDE messaging mostly)
// see sessionSlice for sync redux session functions

export async function getSession(
  ideMessenger: IIdeMessenger,
  id: string,
): Promise<Session> {
  const result = await ideMessenger.request("history/load", { id });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.content;
}

export const refreshSessionMetadata = createAsyncThunk<
  SessionMetadata[],
  {
    offset?: number;
    limit?: number;
    workspaceDirectory?: string;
  },
  ThunkApiType
>("session/refreshMetadata", async ({ offset, limit, workspaceDirectory }, { dispatch, extra }) => {
  const result = await extra.ideMessenger.request("history/list", {
    limit,
    offset,
    workspaceDirectory,
  });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  dispatch(setIsSessionMetadataLoading(false));
  dispatch(setAllSessionMetadata(result.content));
  return result.content;
});

export const deleteSession = createAsyncThunk<void, string, ThunkApiType>(
  "session/delete",
  async (id, { getState, dispatch, extra }) => {
    dispatch(deleteSessionMetadata(id)); // optimistic
    const state = getState();
    if (id === state.session.id) {
      await dispatch(
        loadLastSession({
          saveCurrentSession: false,
        }),
      );
    }
    const result = await extra.ideMessenger.request("history/delete", { id });
    if (result.status === "error") {
      throw new Error(result.error);
    }
    void dispatch(refreshSessionMetadata({}));
  },
);

export const updateSession = createAsyncThunk<void, Session, ThunkApiType>(
  "session/update",
  async (session, { extra, dispatch }) => {
    dispatch(
      updateSessionMetadata({
        sessionId: session.sessionId,
        title: session.title,
        workspaceDirectory: session.workspaceDirectory,
      }),
    ); // optimistic session metadata update
    await extra.ideMessenger.request("history/save", session);
    await dispatch(refreshSessionMetadata({ workspaceDirectory: session.workspaceDirectory }));
  },
);

/*
 this is only used for the custom focusContinueSessionId command at the moment
*/
export const loadSession = createAsyncThunk<
  void,
  {
    sessionId: string;
    saveCurrentSession: boolean;
  },
  ThunkApiType
>(
  "session/load",
  async ({ sessionId, saveCurrentSession: save }, { extra, dispatch }) => {
    if (save) {
      const result = await dispatch(
        saveCurrentSession({
          openNewSession: false,
          generateTitle: true,
        }),
      );
      unwrapResult(result);
    }
    const session = await getSession(extra.ideMessenger, sessionId);
    dispatch(newSession(session));
  },
);

export const loadLastSession = createAsyncThunk<
  void,
  {
    saveCurrentSession: boolean;
  },
  ThunkApiType
>(
  "session/loadLast",
  async ({ saveCurrentSession: shouldSaveCurrentSession }, { extra, dispatch, getState }) => {
    const state = getState();

    // Get the current workspace directory from the IDE
    let workspaceDirectory: string | undefined;
    try {
      const response = await extra.ideMessenger.request("getWorkspaceDirs", undefined);
      if (Array.isArray(response) && response.length > 0) {
        workspaceDirectory = response[0];
      }
    } catch (e) {
      console.warn("Failed to get workspace directory", e);
    }

    // Save current session if needed
    if (state.session.id && shouldSaveCurrentSession) {
      await dispatch(
        saveCurrentSession({
          openNewSession: false,
          generateTitle: true,
        })
      );
    }

    // Get the last session ID from the current workspace
    const metadataResult = await dispatch(
      refreshSessionMetadata({ 
        limit: 1, 
        workspaceDirectory 
      })
    );
    
    const metadata = metadataResult.payload as SessionMetadata[] | undefined;
    const lastSession = metadata?.[0];
    
    if (lastSession) {
      const session = await getSession(extra.ideMessenger, lastSession.sessionId);
      dispatch(newSession(session));
    } else {
      // If no sessions found in the current workspace, start a new one
      dispatch(newSession());
    }
  },
);

function getChatTitleFromMessage(message: ChatMessage) {
  const text =
    renderChatMessage(message)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-1)[0] || "";

  // Truncate
  if (text.length > MAX_TITLE_LENGTH) {
    return text.slice(0, MAX_TITLE_LENGTH - 3) + "...";
  }
  return text;
}

export const saveCurrentSession = createAsyncThunk<
  void,
  { openNewSession: boolean; generateTitle: boolean },
  ThunkApiType
>(
  "session/saveCurrent",
  async ({ openNewSession, generateTitle }, { dispatch, extra, getState }) => {
    const state = getState();
    if (state.session.history.length === 0) {
      return;
    }

    // Get the current workspace directory from the IDE
    let workspaceDirectory = "";
    try {
      const response = await extra.ideMessenger.request("getWorkspaceDirs", undefined);
      if (Array.isArray(response) && response.length > 0) {
        workspaceDirectory = response[0];
      }
    } catch (e) {
      console.warn("Failed to get workspace directory", e);
    }

    if (openNewSession) {
      dispatch(newSession());
    }

    // New session has already been dispatched
    // Now save previous session and update chat title if relevant
    let title = state.session.title;
    if (title === NEW_SESSION_TITLE) {
      const selectedChatModel = selectSelectedChatModel(state);

      if (!state.config.config?.disableSessionTitles && selectedChatModel) {
        let assistantResponse = state.session.history
          ?.filter((h) => h.message.role === "assistant")[0]
          ?.message?.content?.toString();

        if (assistantResponse && generateTitle) {
          try {
            const result = await extra.ideMessenger.request(
              "chatDescriber/describe",
              {
                text: assistantResponse,
              },
            );
            if (result.status === "success" && result.content) {
              title = result.content;
            }
          } catch (e) {
            console.error("Error generating chat title", e);
          }
        }
      }
      // Fallbacks if above doesn't work out or session titles disabled
      if (title === NEW_SESSION_TITLE) {
        title = getChatTitleFromMessage(state.session.history[0].message);
      }
    }
    // More fallbacks in case of no title
    if (!title.length) {
      const metadata = getState().session.allSessionMetadata.find(
        (m) => m.sessionId === state.session.id,
      );
      if (metadata?.title) {
        title = metadata.title;
      }
    }
    if (!title.length) {
      title = NEW_SESSION_TITLE;
    }

    const session: Session = {
      sessionId: state.session.id,
      title,
      workspaceDirectory,
      history: state.session.history,
    };

    const result = await dispatch(updateSession(session));
    unwrapResult(result);
  },
);
