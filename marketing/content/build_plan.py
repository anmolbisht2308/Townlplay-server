"""Generates plan.json, the 4-week TownPlay Instagram plan (run once; plan.json is then the source of truth)."""
import json
from datetime import date, timedelta
from pathlib import Path

START = date(2026, 10, 23)
LIST_OWNER = "DM “LIST” to @_town_play"

HT = {
    "football": "#FootballMemes #FriendsMemes #DesiMemes #SportsIndia #RelatableReels",
    "badminton": "#BadmintonMemes #BadmintonIndia #FriendsMemes #DesiMemes #RelatableReels",
    "cricket": "#BoxCricket #CricketMemes #GullyCricket #DesiMemes #RelatableReels",
    "pickleball": "#Pickleball #PickleballIndia #FriendsMemes #DesiMemes #RelatableReels",
    "owners": "#TurfOwner #SportsBusiness #SmallBusinessIndia #VenueOwner #BoxCricket",
    "academy": "#SportsAcademy #CoachingCentre #SportsBusiness #SmallBusinessIndia #Badminton",
    "events": "#EventsIndia #WeekendPlans #FriendsMemes #DesiMemes #RelatableReels",
    "diwali": "#Diwali #DiwaliParty #FriendsMemes #DesiMemes #RelatableReels",
    "cafe": "#CafeEvents #EventsIndia #SmallBusinessIndia #CafeOwner #Diwali",
    "general": "#FriendsMemes #DesiMemes #SportsIndia #WeekendPlans #RelatableReels",
}


def chat(caption, mark, group, avatar, members, messages, end):
    return {"type": "chat", "caption": caption, "captionMark": mark, "group": group, "avatar": avatar,
            "members": members, "messages": messages, "end": end}


def m(frm, text, time=""):
    return {"from": frm, "text": text, "time": time}


def lst(title, mark, items, end):
    return {"type": "list", "title": title, "titleMark": mark,
            "items": [{"emoji": e, "title": t, "sub": s} for e, t, s in items], "end": end}


def vs(title, mark, left, right, end):
    return {"type": "versus", "title": title, "titleMark": mark,
            "left": {"label": left[0], "lines": left[1]}, "right": {"label": right[0], "lines": right[1]}, "end": end}


def pitch(kicker, hook, hmark, problems, solution, smark, features, end):
    return {"type": "pitch", "kicker": kicker, "hook": hook, "hookMark": hmark,
            "problems": [{"emoji": e, "text": t} for e, t in problems], "solution": solution, "solutionMark": smark,
            "features": [{"emoji": e, "text": t} for e, t in features], "end": end}


def end(title, highlight, tag=None, brand=None, sub=None, cta=None):
    e = {"title": title, "highlight": highlight}
    for k, v in (("tag", tag), ("brandLine", brand), ("sub", sub), ("cta", cta)):
        if v:
            e[k] = v
    return e


OWNER_END = dict(sub="We're onboarding the first venues now", cta=LIST_OWNER, brand="For turfs · courts · box cricket")

E = [
    ("players", "Open games: last-minute drop-outs", HT["football"],
     "2 log kam, game cancel 😭⚽\n\nEvery squad has someone who drops out at 7:30 for an 8 PM game 💀\nTag them 👇",
     "Vikas har group mein hota hai 🥲 Tag yours 👇",
     chat("“Aaj 8 baje game hai” 💀", "8 baje", "Friday Football ⚽", "⚽", "Rahul, Aman, Kabir, Sneha, Vikas +5, You", [
         m("Rahul", "Aaj 8 baje game hai, 10 log chahiye ⚽", "5:02 PM"), m("Aman", "Main aa raha 🔥", "5:03 PM"),
         m("Kabir", "Pakka 💯", "5:03 PM"), {"chip": "7:30 PM"}, m("Vikas", "Bhai aaj nahi ho payega 🥲", "7:31 PM"),
         m("Sneha", "Mera bhai bhi nahi aa raha 😅", "7:32 PM"), m("You", "Ab sirf 8 bache 💀", "7:33 PM"),
         {"typing": "Rahul"}, m("Rahul", "Kisi ka office wala dost? Koi bhi chalega 😭", "7:34 PM")],
         end("2 log kam, game cancel 😭", "game cancel", "Tag your last-minute dropper 👇", "Open games · find players nearby"))),
    ("players", "Badminton doubles types", HT["badminton"],
     "Every badminton doubles match has these 5 people 🏸😂\n\nWhich number are you? Comment below 👇",
     "Main #3 hoon, line pe hi tha 😤 Tum? 👇",
     lst("Every badminton doubles match has these 5 people 🏸", "5 people", [
         ("💥", "“Smash hi maarunga”", "…net mein, har baar"), ("🙋", "“Mera tha!”", "…partner ke saamne se le gaya"),
         ("📏", "“Line pe tha bhai”", "…every single point"), ("🥵", "“Bas 1 game aur”", "…5 games pehle bola tha"),
         ("🏸", "Naya racket, wahi game", "…₹6,000 ka racket, same smash")],
         end("Which one are you?", "you?", "Comment your number 👇", "Book courts · find doubles partners"))),
    ("owners", "Owners: booking calls all day", HT["owners"],
     "Turf owners, raat 11 baje bhi “bhaiya kal 7 baje free hai?” 📞😮‍💨\n\nTownPlay puts your bookings on autopilot. Onboarding the first venues now. DM “LIST” 👇",
     "Owners: how many booking calls do you get a day? 👇",
     pitch("For turf & court owners", "Raat 11 baje bhi phone baj raha hai? 📞", "phone", [
         ("📞", "“Bhaiya kal 7 baje free hai?” all day"), ("📒", "Bookings in a register and WhatsApp"),
         ("🚫", "Slot booked, team never came")],
         "Bookings on autopilot", "autopilot", [
         ("📅", "Live calendar: players book slots themselves"), ("💸", "Advance paid online before the game"),
         ("🏦", "Payouts straight to your bank")],
         end("Venue owner? Get listed early", "listed early", **OWNER_END))),
    ("players", "Booking a turf: calls vs app", HT["football"],
     "Booking a turf, the usual way 📞📞📞 vs one tap ⚡\n\nWhich one does your squad still do? 👇",
     "3 calls minimum, sach bolo 😂👇",
     vs("Booking a turf 😭", "turf", ("The usual way 📞", [
         "Call 1: number busy", "Call 2: “8 baje full hai”", "Call 3: “kal call karna”", "Final: 9:30 PM slot, ₹200 extra 💀"]),
        ("With TownPlay ⚡", ["Open the app, see live slots", "Tap 7 PM, pay the advance", "Done. Show up and play ✅"]),
        end("Book in seconds, not calls", "seconds", "Send this to your squad 📲", "Turfs · courts · box cricket"))),
    ("events", "Comedy show tickets: the friend who pays", HT["events"],
     "Har group ki ticket wali dost 😭🎟️\n\nShe booked for everyone. A week later, still chasing ₹1,996 💀\nTag her 👇",
     "Sneha ko uske paise de do yaar 😭👇",
     chat("“Main sabke tickets book kar deti hoon” 💀", "book", "Standup Night 😂", "🎤", "Sneha, Kabir, Aman, Vikas, You", [
         m("Sneha", "Saturday comedy show hai, chalein? 😂", "6:10 PM"), m("Kabir", "Tickets kitne ke?", "6:11 PM"),
         m("Sneha", "₹499. Main sabke book kar deti hoon 🙌", "6:11 PM"), m("Aman", "Done, paise kal bhejta 👍", "6:12 PM"),
         m("Vikas", "Mera bhi kar de, UPI baad mein 🙏", "6:12 PM"), {"chip": "One week later"},
         m("You", "Sneha abhi bhi ₹1,996 maang rahi hai 💀", "8:40 PM"),
         m("Sneha", "Main ab kabhi kisi ka ticket nahi karungi 😤", "8:41 PM")],
         end("Har group ki ticket wali dost 😭", "ticket wali dost", "Tag her before the next show 👇",
             "Events · everyone pays their own ticket"))),
    ("owners", "Owners: types of customers", HT["owners"],
     "Every turf owner gets these 5 customers 😂\n\nOwners, which one do you get the most? 👇",
     "Owners: #4 at midnight is the worst 😭 Which one for you?",
     lst("Every turf owner gets these 5 customers 😂", "5 customers", [
         ("⏰", "“5 min mein pahunch rahe”", "…40 min late, full time chahiye"), ("💸", "“Thoda discount kar do”", "…har baar, “regular hain”"),
         ("📌", "“Kal ka slot hold karo”", "…kabhi nahi aate"), ("🌙", "Raat 12 baje call", "“Bhaiya kal 6 baje free hai?”"),
         ("🧾", "“Advance baad mein”", "…phir slot cancel")],
         end("Turf owners, which one do you get most?", "most?", "Comment the number 👇", "For venue owners · bookings on autopilot",
             cta="DM “LIST” to get listed"))),
    ("players", "Coaching: 6 AM batch motivation", HT["badminton"],
     "Motivation raat ko, neend subah 😭🏸\n\nTag your 6 AM partner who never shows up 👇",
     "Aman ka alarm kabhi nahi bajta 😴👇",
     chat("“Kal se 6 AM coaching” 💀", "6 AM", "Badminton Coaching 🏸", "🏸", "Aman, Kabir, You", [
         m("Aman", "Kal se 6 AM badminton coaching join karte hain 💪", "11:02 PM"),
         m("Kabir", "Haan, fitness bhi, game bhi 🔥", "11:03 PM"), m("You", "Pakka? Monthly fee ₹1,500 hai", "11:03 PM"),
         m("Kabir", "Bhai bilkul, motivation full hai 💯", "11:04 PM"), {"chip": "Next day, 5:55 AM"},
         m("You", "Main court pe hoon 🙂", "5:55 AM"), {"typing": "Aman"}, m("Aman", "Bhai alarm hi nahi baja 😴", "8:40 AM"),
         m("Kabir", "Kal se pakka 🙏", "8:41 AM")],
         end("Motivation raat ko, neend subah 😭", "neend subah", "Tag your 6 AM partner 👇", "Coaching batches · memberships"))),
    ("owners", "Owners: before vs after", HT["owners"],
     "Running a turf: before vs after TownPlay ⚡\n\nOnboarding the first venues now. Owners, DM “LIST” 👇",
     "Owners: which “before” hurts the most? 👇",
     vs("Running a turf 😮‍💨", "turf", ("Before 😩", [
         "Phone calls till midnight", "Register full of cuttings", "No-shows on Saturday night", "Cash, UPI, udhaar… hisaab kahan?"]),
        ("With TownPlay ⚡", ["Players book live slots themselves", "Advance paid online, fewer no-shows",
                              "Walk-ins and blocks on one calendar", "Earnings and payouts in one place"]),
        end("Your venue on autopilot", "autopilot", **OWNER_END))),
    ("players", "Box cricket: team selection", HT["cricket"],
     "Har baar last pick 😭🏏\n\nTag the friend who always ends up as umpire 👇",
     "Umpire bhi important hai bhai 😂👇",
     chat("Box cricket team selection 💀", "team selection", "Box Cricket 🏏", "🏏", "Aman, Kabir, Vikas, Sneha, Rohit +3, You", [
         m("Aman", "Captain main aur Kabir, teams bana lete hain 🏏", "6:20 PM"), m("Kabir", "Pehla pick: Vikas 🔥", "6:20 PM"),
         m("Aman", "Pehla pick: Rohit", "6:21 PM"), m("Kabir", "Second: Sneha", "6:21 PM"), {"chip": "8 picks later"},
         m("You", "Aur main? 🙂", "6:24 PM"), m("Aman", "Tu umpire ban ja bhai 😂", "6:24 PM"), {"typing": "Kabir"},
         m("Kabir", "Ya scorer 💀", "6:25 PM")],
         end("Har baar last pick 😭", "last pick", "Tag the one who always gets picked last 👇", "Box cricket · open games"))),
    ("players", "Sunday football lines", HT["football"],
     "Things you hear at every Sunday football game ⚽😂\n\nWhich one did your squad say today? 👇",
     "“Last goal wins” aur 3 goals baad bhi game chalu 😂",
     lst("Things you hear at every Sunday football game ⚽", "Sunday football", [
         ("⏱️", "“Last goal wins”", "…phir 3 aur goals"), ("🧤", "“Rolling keeper”", "…koi roll nahi karta"),
         ("🤕", "“Bhai thoda dheere”", "…5-a-side World Cup final"), ("💸", "“Paise baad mein”", "…kabhi nahi"),
         ("📸", "“Ek photo le lo”", "…sab thake hue, phir bhi")],
         end("Which one did your squad say today?", "today?", "Send this to the group 📲", "Book turfs · split the bill"))),
    ("owners", "Owners: empty weekday slots", HT["owners"],
     "Weekday afternoons = empty turf? 🥲\n\nOpen games, coaching batches and events fill the quiet hours. Owners, DM “LIST” 👇",
     "Owners: which hours are emptiest at your venue? 👇",
     pitch("For venue owners", "Weekday afternoons = empty turf? 🥲", "empty turf", [
         ("🕑", "2–5 PM slots empty every weekday"), ("📉", "Fixed costs, zero bookings"), ("📣", "No easy way to reach new players")],
         "Fill the empty hours", "empty hours", [
         ("👥", "Open games: solo players join and fill slots"), ("🎓", "Coaching batches on fixed weekday slots"),
         ("🎟️", "Events and tournaments with tickets")],
         end("More players, fewer empty slots", "fewer empty slots", **OWNER_END))),
    ("players", "Pickleball: one game becomes a habit", HT["pickleball"],
     "Ek game ka plan, roz ki aadat 😭🏓\n\nWho got your group into pickleball? Tag them 👇",
     "Paddle abhi tak nahi aaya Vikas ka 😂",
     chat("“Pickleball try karein?” 🏓", "Pickleball", "Pickleball Crew 🏓", "🏓", "Kabir, Aman, Sneha, Vikas, You", [
         m("Kabir", "Bhai pickleball try karein? Sab kar rahe hain 🏓", "7:10 PM"),
         m("Aman", "Ye kya hai, badminton aur tennis ka bachcha? 😂", "7:11 PM"), m("Sneha", "Court ₹800/hour, 4 log 🙌", "7:11 PM"),
         m("You", "Main paddles le aaunga 👍", "7:12 PM"), {"chip": "After the game"},
         m("Aman", "Bhai ye toh addictive hai 🔥", "9:05 PM"), m("Kabir", "Kal phir? Same time? 🏓", "9:05 PM"),
         m("Vikas", "Mera paddle kab aayega? 😂", "9:06 PM")],
         end("Ek game ka plan, roz ki aadat 😭", "roz ki aadat", "Tag your pickleball partner 👇", "Pickleball · badminton · turfs"))),
    ("players", "Split bill: old way vs split before", HT["football"],
     "After the game: “sab ₹150 bhejo” → seen by 8 👀💀\n\nSplit before you play. Send this to your group's money collector 📲",
     "Money collector ko tag karo 😭👇",
     vs("After the game 💸", "game", ("Old way 😩", ["“Sab ₹150 bhejo”", "Seen by 8 👀", "3 reminders later: 2 paid", "You paid ₹900 extra 🥲"]),
        ("TownPlay way ✅", ["Book and split before the game", "Everyone pays their own share", "No chasing, no udhaar"]),
        end("Split before you play", "before", "Send this to your money collector 📲", "Book · play · split the bill"))),
    ("events", "Diwali party group chat types", HT["diwali"],
     "Every Diwali party plan has these 5 moments 🪔😂\n\nTag your group's party planner 👇",
     "“Kiske ghar pe?” … sab chup 😂",
     lst("Every Diwali party plan 🪔", "Diwali", [
         ("🪔", "“Is baar badi party karte hain”", "…plan bana 3 hafte pehle"), ("🃏", "“Taash toh hoga na?”", "…har saal wahi"),
         ("👗", "“Dress code rakhte hain”", "…aadhe log bhool gaye"), ("💸", "“Contribution kitna?”", "…sab chup"),
         ("🏠", "“Kiske ghar pe?”", "…koi nahi bolta")],
         end("Har saal ka Diwali plan 😭", "Diwali plan", "Tag your party planner 👇", "Events · cafés · group plans"))),
    ("events", "Diwali night event tickets", HT["diwali"],
     "Party ka plan, paise ka drama 😭🪔\n\n“Mere 2 friends free mein?” 💀 Tag your party group 👇",
     "Aman ke 2 friends kaun hain 😂👇",
     chat("Diwali night event ka plan 🪔", "Diwali night", "Diwali Night 🪔", "🪔", "Sneha, Kabir, Vikas, Aman, You", [
         m("Sneha", "Diwali night event hai, DJ + food 🎉", "4:15 PM"), m("Kabir", "Entry kitne ki?", "4:16 PM"),
         m("Sneha", "₹599, couple ₹999 💃", "4:16 PM"), m("Vikas", "Couple ticket? Mere liye single hi 🥲", "4:17 PM"),
         m("Aman", "Main 2 friends laa raha 🔥", "4:17 PM"), m("You", "Toh 7 log, ₹599 each 🙏", "4:18 PM"),
         {"typing": "Aman"}, m("Aman", "Mere 2 friends free mein? 🙂", "4:19 PM")],
         end("Party ka plan, paise ka drama 😭", "paise ka drama", "Tag your party group 👇", "Event tickets · everyone pays their own"))),
    ("owners", "Cafés/venues: selling event tickets", HT["cafe"],
     "Hosting an event this Diwali? 🪔\n\nTicket tiers, online payment and QR check-in in one place. Cafés & venues, DM “LIST” 👇",
     "Café owners: what's the hardest part of running events? 👇",
     pitch("For cafés & venue owners", "Hosting an event this Diwali? 🪔", "event", [
         ("📲", "Bookings in DMs and screenshots"), ("🧾", "“Paid” but no money received"), ("🚪", "Long queue at the entry")],
         "Sell tickets the easy way", "easy way", [
         ("🎟️", "Ticket tiers: early bird, couple, VIP"), ("💳", "Online payment, instant confirmation"), ("📱", "QR check-in at the door")],
         end("Host events that sell out", "sell out", sub="Free and paid events · cafés · venues", cta=LIST_OWNER,
             brand="Event tickets for cafés & venues"))),
    ("players", "Diwali day: types in every group", HT["diwali"],
     "Happy Diwali 🪔✨ Every group has these 5 on Diwali night 😂\n\nTag your Diwali squad 👇",
     "Happy Diwali from TownPlay 🪔 Which one are you?",
     lst("Diwali night, har group mein 🪔", "har group", [
         ("🎆", "Pataka expert", "“Bhai ye wala alag hai”"), ("🍬", "Mithai inspector", "…har ghar ki rating"),
         ("🃏", "Taash champion", "…saal bhar ka hisaab ek raat mein"), ("📸", "Photographer", "…khud kisi photo mein nahi"),
         ("😴", "Early sleeper", "…10 baje gayab")],
         end("Happy Diwali from TownPlay 🪔", "Happy Diwali", "Tag your Diwali squad 👇", "Play more · plan more"))),
    ("owners", "Owners: Saturday no-shows", HT["owners"],
     "Saturday night slot booked… team never came 😬\n\nWith an online advance, no-shows stop costing you. Owners, DM “LIST” 👇",
     "Owners: how many no-shows last month? 👇",
     vs("Saturday night at your turf 🌙", "Saturday night", ("Without advance 😬", [
         "Slot booked on a call", "Team texts “10 min late”", "Never shows up", "Slot empty, ₹1,500 gone"]),
        ("With TownPlay ✅", ["Player pays the advance online", "Slot locked, no double booking", "No-show? Advance already paid"]),
        end("No more no-show losses", "no-show", **OWNER_END))),
    ("players", "Rain on game day", HT["football"],
     "Advance diya, baarish aayi 😭🌧️\n\nTag your rain-day squad 👇",
     "9 baje baarish band ho jaati hai, hamesha 😂",
     chat("Game day pe baarish 🌧️", "baarish", "Evening Football ⚽", "⚽", "Rahul, Aman, Kabir, Vikas +6, You", [
         m("Rahul", "Turf 7 baje, sab ready? ⚽", "5:40 PM"), m("Aman", "Bahar dekh, baarish ho rahi 🌧️", "5:41 PM"),
         m("Kabir", "Bhai turf ka advance diya hai 😭", "5:41 PM"), m("You", "Cancel karein? Refund milega?", "5:42 PM"),
         m("Rahul", "Bhaiya bol rahe “next time adjust kar denge” 🙂", "5:44 PM"), {"chip": "9:00 PM"},
         m("Vikas", "Baarish band. Abhi chalein? 😂", "9:00 PM")],
         end("Advance gaya, baarish aayi 😭", "baarish aayi", "Tag your rain-day squad 👇",
             "Cancellation & refund rules shown before you book"))),
    ("players", "Sports WhatsApp group types", HT["general"],
     "Every sports WhatsApp group has these 5 people 📱😂\n\nWhich number are you? 👇",
     "Main #2 hoon 👍 (aaunga nahi) 😂",
     lst("Every sports WhatsApp group has these 5 people 📱", "5 people", [
         ("📊", "Poll banane wala", "…koi vote nahi karta"), ("👍", "Sirf thumbs up", "…aata kabhi nahi"),
         ("🌅", "Good morning forwarder", "…sports group mein bhi"), ("🗓️", "“Kal pakka”", "…kal kabhi nahi aata"),
         ("🦸", "Admin", "…booking, paise, reminder, sab akela")],
         end("Which one are you?", "you?", "Comment your number 👇", "Open games · split payments · reminders"))),
    ("owners", "Owners: payments and payouts", HT["owners"],
     "Cash, UPI, udhaar… month end pe hisaab? 📒😮‍💨\n\nEvery rupee tracked, payouts to your bank. Owners, DM “LIST” 👇",
     "Owners: register or Excel? 👇",
     pitch("For venue owners", "Hisaab ka register ab band? 📒", "register", [
         ("💵", "Cash, UPI, udhaar, sab mix"), ("🧮", "Month end: kitna aaya, pata nahi"), ("📞", "Chasing teams for the balance")],
         "Every rupee tracked", "tracked", [
         ("📊", "Earnings: online and at-venue payments"), ("🏦", "Payouts straight to your bank"),
         ("🧾", "Every booking, refund and payout recorded")],
         end("Run your venue like a pro", "like a pro", **OWNER_END))),
    ("players", "Group can't decide the sport", HT["general"],
     "3 sports, 1 Ludo 😭🎲\n\nTag the group that never decides 👇",
     "Ludo bhi sport hai, bolo 😂",
     chat("Weekend pe kya khelein? 🤔", "kya khelein?", "College Gang 🎓", "🎓", "Aman, Sneha, Kabir, Vikas, You", [
         m("You", "Weekend pe kuch khelte hain? 🏏⚽🏸", "8:10 PM"), m("Aman", "Cricket? 🏏", "8:10 PM"),
         m("Sneha", "Badminton 🏸", "8:11 PM"), m("Kabir", "Football ⚽", "8:11 PM"), m("Vikas", "Main toh bas khaane aaunga 🍕", "8:12 PM"),
         {"chip": "45 messages later"}, m("You", "Final kya hua?", "10:30 PM"), m("Aman", "Ghar pe Ludo 🎲", "10:31 PM")],
         end("3 sports, 1 Ludo 😭", "1 Ludo", "Tag the group that never decides 👇", "Games · events · cafés near you"))),
    ("players", "Solo player: open games", HT["football"],
     "Want to play but no team? 🥲\n\nOpen games let you join a game near you and pay just your share. Send this to your solo-player friend 📲",
     "Kaun kaun solo khelna chahta hai? 🙋👇",
     vs("Want to play, but no team? 🥲", "no team", ("Before 😩", [
         "Ask in 5 groups", "“Bhai is week nahi”", "Watch others play on Instagram"]),
        ("With open games ⚡", ["See games near you needing players", "Join in one tap, pay your share", "Show up, play, make new friends"]),
        end("Your next game is 1 tap away", "1 tap away", "Send this to your solo-player friend 📲", "Open games near you"))),
    ("owners", "Owners: things every turf owner says", HT["owners"],
     "Things every turf owner has said 😂📞\n\nOwners, did we miss one? 👇",
     "Owners: add yours below 👇",
     lst("Things every turf owner has said 😂", "turf owner", [
         ("📞", "“Haan ji, 7 baje free hai”", "…20 times a day"), ("💡", "“Lights 10 min extra nahi”", "…har team ko"),
         ("🧴", "“Bottle andar mat laana”", "…turf pe 10 bottles"), ("💸", "“Advance bhejo pehle”", "“bhaiya pahunch ke de denge”"),
         ("🌧️", "“Baarish mein refund nahi”", "…phir bhi 30 calls")],
         end("Turf owners, did we miss one?", "miss one?", "Comment below 👇", "For venue owners", cta="DM “LIST” to get listed"))),
    ("players", "Membership: 20 days, josh 3 days", HT["badminton"],
     "Membership 20 din, josh 3 din 😭🏸\n\nTag your morning partner 👇",
     "Day 20 tak kaun bacha tha tumhare group mein? 😂",
     chat("“Monthly membership le lein?” 🏸", "membership", "Morning Badminton 🌅", "🌅", "Aman, Kabir, Sneha, You", [
         m("Aman", "Monthly membership le lein? ₹2,000 mein 20 sessions 🏸", "9:00 PM"),
         m("Kabir", "Haan, roz aayenge 💪", "9:01 PM"), m("Sneha", "Main bhi in 🔥", "9:01 PM"),
         {"chip": "Day 1: 4/4 present"}, {"chip": "Day 7: 2/4 present"}, {"chip": "Day 20"},
         m("You", "Sirf main bacha hoon 🙂", "6:05 AM"), m("Kabir", "Bhai membership extend ho sakti hai? 😅", "9:30 AM")],
         end("Membership 20 din, josh 3 din 😭", "josh 3 din", "Tag your morning partner 👇", "Memberships · coaching batches"))),
    ("owners", "Academies: batches and memberships", HT["academy"],
     "Coaching academy owners: fees, renewals and batch slots, without the register 📒\n\nDM “LIST” 👇",
     "Academy owners: how do you track renewals today? 👇",
     vs("Coaching academy owner? 🎓", "academy owner", ("The register way 📒", [
         "Fees in cash, reminders on WhatsApp", "Who renewed? Who didn't?", "Batch slots clash with bookings"]),
        ("With TownPlay ✅", ["Members pay and renew online", "Batch slots reserved on your calendar", "Attendance in one tap"]),
        end("Run batches without the chaos", "without the chaos", sub="Coaching · memberships · venues", cta=LIST_OWNER,
            brand="For academies & coaches"))),
    ("players", "Box cricket batsman types", HT["cricket"],
     "Every box cricket match has these 5 batsmen 🏏😂\n\nWhich one are you? 👇",
     "#3 “Trial ball tha” wala har team mein 💀",
     lst("Every box cricket match has these 5 batsmen 🏏", "5 batsmen", [
         ("💥", "Sirf six", "…ya out, beech mein kuch nahi"), ("🐢", "Test match specialist", "…10 balls, 3 runs"),
         ("🙅", "“Trial ball tha”", "…har out pe"), ("🧱", "“Wall pe laga, 4 hai”", "…naya rule, abhi bana"),
         ("🏃", "Running between wickets", "…30 foot ke box mein")],
         end("Which batsman are you?", "you?", "Comment your number 👇", "Box cricket · turfs · split the cost"))),
    ("owners", "Owners: early access call", HT["owners"],
     "Venue owners: be one of the first on TownPlay 🚀\n\nLive calendar, online advance, open games, batches, events and payouts. DM “LIST” 👇",
     "Owners: which feature would help you most? 👇",
     pitch("Venue owners · early access", "Be one of the first venues on TownPlay 🚀", "first venues", [
         ("📞", "Tired of booking calls?"), ("🚫", "Losing money to no-shows?"), ("🕑", "Empty weekday slots?")],
         "One app for your venue", "One app", [
         ("📅", "Live calendar and online booking"), ("👥", "Open games, coaching batches, events"),
         ("🏦", "Advance online, payouts to your bank")],
         end("Get listed early", "early", sub="We're onboarding venues city by city", cta=LIST_OWNER,
             brand="For turfs · courts · academies"))),
]

entries = []
for i, (aud, topic, tags, caption, comment, spec) in enumerate(E):
    d = START + timedelta(days=i)
    entries.append({
        "id": f"d{i + 1:02d}", "date": d.isoformat(), "weekday": d.strftime("%a"), "audience": aud,
        "format": spec["type"], "topic": topic, "spec": spec,
        "caption": f"{caption}\n\n{tags}", "firstComment": comment, "status": "planned",
    })

out = {"account": "@_town_play", "metricoolBrandId": 7428293, "postTimeIST": "11:00", "entries": entries}
Path(__file__).with_name("plan.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(len(entries), "entries", entries[0]["date"], "->", entries[-1]["date"])
