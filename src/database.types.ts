
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "match_results": {
                  Row: {
                    "finished_at": string,"id": string,"names": NonNullable<Json>,"room_id": string | null,"room_name": string | null,"scores": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "finished_at"?: string,"id"?: string,"names"?: NonNullable<Json>,"room_id"?: string | null,"room_name"?: string | null,"scores": NonNullable<Json>
                  }
                  Update: {
                    "finished_at"?: string,"id"?: string,"names"?: NonNullable<Json>,"room_id"?: string | null,"room_name"?: string | null,"scores"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "match_results_room_id_fkey"
      columns: ["room_id"]
isOneToOne: true
      referencedRelation: "lobby_rooms"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "match_results_room_id_fkey"
      columns: ["room_id"]
isOneToOne: true
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "display_name": string,"id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "display_name": string,"id": string
                  }
                  Update: {
                    "display_name"?: string,"id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"room_players": {
                  Row: {
                    "joined_at": string,"player_id": string,"room_id": string,"seat": number
                  }
                  ComputedFields: never
                  Insert: {
                    "joined_at"?: string,"player_id": string,"room_id": string,"seat": number
                  }
                  Update: {
                    "joined_at"?: string,"player_id"?: string,"room_id"?: string,"seat"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "room_players_player_id_fkey"
      columns: ["player_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "room_players_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "lobby_rooms"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "room_players_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"rooms": {
                  Row: {
                    "created_at": string,"goal_limit": number,"host_id": string,"id": string,"max_players": number,"name": string,"started_at": string | null,"starting_players": (string)[] | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"goal_limit"?: number,"host_id": string,"id"?: string,"max_players": number,"name": string,"started_at"?: string | null,"starting_players"?: (string)[] | null,"status"?: string
                  }
                  Update: {
                    "created_at"?: string,"goal_limit"?: number,"host_id"?: string,"id"?: string,"max_players"?: number,"name"?: string,"started_at"?: string | null,"starting_players"?: (string)[] | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rooms_host_id_fkey"
      columns: ["host_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "leaderboard": {
                  Row: {
                    "display_name": string | null,"matches": number | null,"player_id": string | null,"points": number | null,"rank": number | null,"wins": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"lobby_rooms": {
                  Row: {
                    "created_at": string,"goal_limit": number,"host_id": string,"host_name": string,"id": string,"max_players": number,"name": string,"player_count": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "rooms_host_id_fkey"
      columns: ["host_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"match_players": {
                  Row: {
                    "display_name": string | null,"finished_at": string,"place": number | null,"player_count": number | null,"player_id": string | null,"result_id": string,"room_name": string | null,"score": number | null,"won": boolean | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "cleanup":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"create_room":
{ Args: { "p_goal_limit"?: number,"p_max_players": number,"p_name": string }; Returns: string
                           },
"finish_match":
{ Args: { "p_room_id": string,"p_scores": Json }; Returns: string
                           },
"join_room":
{ Args: { "p_room_id": string }; Returns: number
                           },
"set_room_status":
{ Args: { "p_room_id": string,"p_status": string }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
