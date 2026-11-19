import { TurnSpecError } from "../../../../src/turn/types";
import { registerErrorClass } from "../native";

registerErrorClass(
  "TurnSpecError",
  (tag) =>
    new TurnSpecError(tag.code as ConstructorParameters<typeof TurnSpecError>[0], tag.id ?? "", tag.message)
);
