import { createContext, useContext } from "react";

/** In-stage captions and footer. The MP4s show them; the scrolling page renders the captions as page text instead. */
export const ShowChrome = createContext(true);
export const useShowChrome = () => useContext(ShowChrome);
